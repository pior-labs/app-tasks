import { type APIRequestContext, type Browser, expect, type Page, test, type TestInfo } from '@playwright/test';

// Shared lists in a real browser, with Household One and Household Two signed
// in side by side in separate browser contexts, against the Vite dev server
// and the real API on a disposable database. The criteria named below are
// those of the shared lists task.
//
// All tests share one database for the run. This file runs after
// lists.spec.ts and before tasks.spec.ts, which expects Household Two to start
// without tasks or lists, and Household One's rows to be its own. So every
// test here uses names starting with "Shared:", and leaves no shared list,
// nothing of Household Two's and none of its own rows behind (cleanUp).

type FixtureUser = 'Household One' | 'Household Two';

const webOrigin = `http://localhost:${process.env.E2E_WEB_PORT ?? 5273}`;

async function signIn(page: Page, user: FixtureUser) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByText(`Signed in as ${user}`)).toBeVisible();
  await expect(page.getByLabel('New task')).toBeVisible();
}
// A member in their own browser context. The page clock is installed (it
// keeps running at the real pace) so a test can jump to the next 30-second
// refresh instead of waiting for it.
async function member(browser: Browser, user: FixtureUser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await page.clock.install();
  await signIn(page, user);
  return page;
}
// The next background refresh, without a reload: the page's 30-second timer.
// A marker set on the window would not survive a reload, so the caller can
// prove that none happened.
async function nextRefresh(page: Page) {
  await page.evaluate(() => ((window as unknown as { noReload: boolean }).noReload = true));
  await page.clock.fastForward(30_000);
}
async function expectNoReload(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { noReload?: boolean }).noReload)).toBe(true);
}

const tablist = (page: Page) => page.getByRole('tablist', { name: 'Lists' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const sharedTab = (page: Page, name: string) => tab(page, `${name} (shared)`);
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const labels = (page: Page, title: string) => rowOf(page, title).locator('[data-share-labels]');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const completedToggle = (page: Page) => page.getByRole('button', { name: /^Completed \(\d+\)$/ });

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
  await expect(checkbox(page, title)).toBeVisible();
}
async function createList(page: Page, name: string) {
  await button(page, 'New list').click();
  await page.getByRole('textbox', { name: 'List name' }).fill(name);
  await page.getByRole('textbox', { name: 'List name' }).press('Enter');
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
}
async function openManage(page: Page) {
  if ((await button(page, 'Manage lists').getAttribute('aria-expanded')) !== 'true') {
    await button(page, 'Manage lists').click();
  }
  await expect(page.getByRole('list', { name: 'Your lists' })).toBeVisible();
}
async function share(page: Page, name: string) {
  await openManage(page);
  await button(page, `Share "${name}" with household`).click();
  await expect(sharedTab(page, name)).toBeVisible();
  await button(page, 'Manage lists').click();
}
async function expandCompleted(page: Page) {
  if ((await completedToggle(page).getAttribute('aria-expanded')) === 'false') await completedToggle(page).click();
  await expect(completedToggle(page)).toHaveAttribute('aria-expanded', 'true');
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

// Through the API with the member's session (the context's cookies): first
// every shared list stops being shared (any member may), then Household Two's
// tasks and lists, and every "Shared:" row of Household One, are deleted.
async function cleanUp(one: Page, two: Page) {
  const headers = { Origin: webOrigin };
  const call = async (request: APIRequestContext, method: 'get' | 'patch' | 'delete', path: string, data?: unknown) => {
    const response = await request[method](path, { headers, ...(data === undefined ? {} : { data }) });
    expect(response.ok(), `${method} ${path}`).toBe(true);
    return method === 'delete' ? null : response.json();
  };
  const oneRequest = one.context().request;
  const twoRequest = two.context().request;
  for (const list of (await call(twoRequest, 'get', '/api/lists')).lists) {
    if (list.shared) await call(twoRequest, 'patch', `/api/lists/${list.id}`, { shared: false });
  }
  for (const task of (await call(twoRequest, 'get', '/api/tasks')).tasks) await call(twoRequest, 'delete', `/api/tasks/${task.id}`);
  for (const list of (await call(twoRequest, 'get', '/api/lists')).lists) await call(twoRequest, 'delete', `/api/lists/${list.id}`);
  for (const task of (await call(oneRequest, 'get', '/api/tasks')).tasks) {
    if (task.title.startsWith('Shared:')) await call(oneRequest, 'delete', `/api/tasks/${task.id}`);
  }
  for (const list of (await call(oneRequest, 'get', '/api/lists')).lists) {
    if (list.name.startsWith('Shared:')) await call(oneRequest, 'delete', `/api/lists/${list.id}`);
  }
  expect((await call(twoRequest, 'get', '/api/tasks')).tasks).toEqual([]);
  expect((await call(twoRequest, 'get', '/api/lists')).lists).toEqual([]);
  await one.context().close();
  await two.context().close();
}

test('One shares a list; Two sees it, adds, completes and is assigned; an unshared list stays private (AC-15)', async ({
  browser,
}, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: private');
    await addTask(one, 'Shared: diary');
    await createList(one, 'Shared: groceries');
    await addTask(one, 'Shared: oat milk');
    await addTask(one, 'Shared: eggs');
    // Nothing is shared yet.
    await two.reload();
    await expect(tab(two, 'Shared: groceries')).toHaveCount(0);

    await share(one, 'Shared: groceries');
    await expect(sharedTab(one, 'Shared: groceries')).toHaveAttribute('aria-selected', 'true');
    // Two sees it on the next refresh, without a reload.
    await nextRefresh(two);
    await expect(sharedTab(two, 'Shared: groceries')).toBeVisible();
    await expectNoReload(two);
    // And after a reload.
    await two.reload();
    await expect(sharedTab(two, 'Shared: groceries')).toBeVisible();
    // The unshared list and its task never show for Two.
    await expect(tablist(two).getByRole('tab', { name: /Shared: private/ })).toHaveCount(0);
    await expect(two.getByText('Shared: diary')).toHaveCount(0);

    // Two adds a task in One's list; One sees who added it.
    await sharedTab(two, 'Shared: groceries').click();
    await addTask(two, 'Shared: bread');
    await expect(labels(two, 'Shared: bread')).toHaveCount(0);
    await nextRefresh(one);
    await expect(labels(one, 'Shared: bread')).toHaveText('Added by Household Two');
    await expectNoReload(one);
    await screenshot(one, testInfo, 'sharing-added-by');

    // Two completes One's task; One sees who did.
    await checkbox(two, 'Shared: oat milk').click();
    await expect(two.getByRole('status')).toHaveText('"Shared: oat milk" was moved to Completed.');
    await nextRefresh(one);
    await expandCompleted(one);
    await expect(checkbox(one, 'Shared: oat milk')).toBeChecked();
    await expect(labels(one, 'Shared: oat milk')).toHaveText('Done by Household Two');
    await screenshot(one, testInfo, 'sharing-done-by');

    // One assigns a task to Two; Two sees it is theirs.
    await button(one, 'Edit "Shared: eggs"').click();
    await one.getByRole('combobox', { name: 'Assigned to, for "Shared: eggs"' }).selectOption({ label: 'Household Two' });
    await button(one, 'Save').click();
    await expect(labels(one, 'Shared: eggs')).toHaveText('Assigned to Household Two');
    await nextRefresh(two);
    await expect(labels(two, 'Shared: eggs')).toHaveText('Added by Household One \u00B7 Assigned to you');
    await expectNoReload(two);
    await screenshot(two, testInfo, 'sharing-assigned-to-you');
  } finally {
    await cleanUp(one, two);
  }
});

test('Two renames and stops sharing One\'s list: Two loses it, One keeps it with every task (AC-15, D-2)', async ({
  browser,
}, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: chores');
    await addTask(one, 'Shared: hoover');
    await share(one, 'Shared: chores');
    await two.reload();
    await sharedTab(two, 'Shared: chores').click();
    await addTask(two, 'Shared: dust');

    await openManage(two);
    await expect(two.locator('[data-list-id]').filter({ hasText: 'Shared: chores' }).locator('[data-list-sharing]')).toHaveText(
      'Shared by Household One',
    );
    await button(two, 'Rename "Shared: chores"').click();
    await two.getByRole('textbox', { name: 'New name for "Shared: chores"' }).fill('Shared: weekly chores');
    await two.keyboard.press('Enter');
    await expect(sharedTab(two, 'Shared: weekly chores')).toBeVisible();

    await button(two, 'Stop sharing "Shared: weekly chores"').click();
    await expect(two.getByRole('group', { name: 'Stop sharing "Shared: weekly chores"?' })).toContainText(
      'you will lose access to it',
    );
    await screenshot(two, testInfo, 'sharing-stop-question');
    await button(two, 'Confirm stopping sharing "Shared: weekly chores"').click();
    await expect(tablist(two).getByRole('tab', { name: /Shared: weekly chores/ })).toHaveCount(0);
    await expect(tab(two, 'Inbox')).toHaveAttribute('aria-selected', 'true');
    await expect(two.getByText('Shared: dust')).toHaveCount(0);
    await two.reload();
    await expect(tablist(two).getByRole('tab', { name: /Shared: weekly chores/ })).toHaveCount(0);

    // One keeps the renamed list, unshared, with both tasks.
    await nextRefresh(one);
    await expect(tab(one, 'Shared: weekly chores')).toHaveAttribute('aria-selected', 'true');
    await expect(checkbox(one, 'Shared: hoover')).toBeVisible();
    await expect(checkbox(one, 'Shared: dust')).toBeVisible();
    await expect(labels(one, 'Shared: dust')).toHaveCount(0);
  } finally {
    await cleanUp(one, two);
  }
});

test('deleting a shared list sends each task to the Inbox of whoever added it (AC-15, D-4)', async ({ browser }) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: party');
    await addTask(one, 'Shared: balloons');
    await share(one, 'Shared: party');
    await two.reload();
    await sharedTab(two, 'Shared: party').click();
    await addTask(two, 'Shared: cake');

    await openManage(two);
    await button(two, 'Delete list "Shared: party"').click();
    await expect(two.getByRole('group', { name: 'Delete list "Shared: party"?' })).toContainText(
      'Its 2 tasks will return to the Inbox of whoever added them.',
    );
    await button(two, 'Confirm deleting list "Shared: party"').click();
    await expect(tablist(two).getByRole('tab', { name: /Shared: party/ })).toHaveCount(0);
    await tab(two, 'Inbox').click();
    await expect(checkbox(two, 'Shared: cake')).toBeVisible();
    await expect(two.getByText('Shared: balloons')).toHaveCount(0);

    // One's view of the list was selected: it switches to Inbox with a notice.
    await nextRefresh(one);
    await expect(tab(one, 'Inbox')).toHaveAttribute('aria-selected', 'true');
    await expect(one.getByRole('status')).toHaveText(
      '"Shared: party" was deleted or is no longer shared with you, so Inbox is shown.',
    );
    await expect(checkbox(one, 'Shared: balloons')).toBeVisible();
    await expect(one.getByText('Shared: cake')).toHaveCount(0);
  } finally {
    await cleanUp(one, two);
  }
});

test('the share toggle and the Assigned to select work by keyboard; the tab row fits a phone (AC-15)', async ({
  browser,
}, testInfo) => {
  const one = await member(browser, 'Household One', { width: 390, height: 844 });
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: kitchen and pantry restock');
    await addTask(one, 'Shared: flour');

    // Manage lists, then the list's share toggle, by keyboard only.
    await button(one, 'Manage lists').focus();
    await one.keyboard.press('Enter');
    const toggle = button(one, 'Share "Shared: kitchen and pantry restock" with household');
    for (let presses = 0; presses < 40 && !(await toggle.evaluate((element) => element === document.activeElement)); presses++) {
      await one.keyboard.press('Tab');
    }
    await expect(toggle).toBeFocused();
    await one.keyboard.press('Enter');
    const stop = button(one, 'Stop sharing "Shared: kitchen and pantry restock"');
    await expect(stop).toBeFocused();
    await expect(sharedTab(one, 'Shared: kitchen and pantry restock')).toBeVisible();
    await one.keyboard.press('Escape');

    // The tab row, with the marker, scrolls inside itself; the page does not.
    const measured = await one.evaluate(() => {
      const row = document.querySelector('[role="tablist"]')!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rowRight: row.getBoundingClientRect().right,
        viewport: document.documentElement.clientWidth,
      };
    });
    expect(measured.page).toBe(0);
    expect(measured.rowRight).toBeLessThanOrEqual(measured.viewport);
    // In Manage lists, the name keeps a readable width; the buttons wrap below it.
    const nameWidth = await one
      .locator('[data-list-id]')
      .filter({ hasText: 'Shared: kitchen and pantry restock' })
      .locator('[data-list-name]')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(nameWidth).toBeGreaterThanOrEqual(160);
    await expect(sharedTab(one, 'Shared: kitchen and pantry restock').locator('svg')).toBeVisible();
    await expect(sharedTab(one, 'Shared: kitchen and pantry restock')).toBeInViewport();
    await screenshot(one, testInfo, 'sharing-phone-tab-row');

    // The Assigned to select, by keyboard: Tab from the List select, arrow
    // to Household Two, Enter saves.
    await button(one, 'Edit "Shared: flour"').focus();
    await one.keyboard.press('Enter');
    const listSelect = one.getByRole('combobox', { name: 'List for "Shared: flour"' });
    const assigned = one.getByRole('combobox', { name: 'Assigned to, for "Shared: flour"' });
    await listSelect.focus();
    await one.keyboard.press('Tab');
    await expect(assigned).toBeFocused();
    await expect(assigned).toHaveValue('');
    await one.keyboard.press('ArrowDown');
    await one.keyboard.press('ArrowDown');
    await expect(assigned.locator('option:checked')).toHaveText('Household Two');
    await expect(one.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).resolves.toBe(0);
    await screenshot(one, testInfo, 'sharing-phone-assigned-select');
    await one.getByRole('textbox', { name: 'New title for "Shared: flour"' }).focus();
    await one.keyboard.press('Enter');
    await expect(labels(one, 'Shared: flour')).toHaveText('Assigned to Household Two');
    await expect(button(one, 'Edit "Shared: flour"')).toBeFocused();

    await two.reload();
    await sharedTab(two, 'Shared: kitchen and pantry restock').click();
    await expect(labels(two, 'Shared: flour')).toHaveText('Added by Household One \u00B7 Assigned to you');
  } finally {
    await cleanUp(one, two);
  }
});
