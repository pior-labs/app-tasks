import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

// Shared lists in a real browser, with Household One and Household Two signed
// in side by side in separate browser contexts, against the Vite dev server
// and the real API on a disposable database. The criteria named below are
// those of the shared lists task.
//
// Every test starts with no lists or tasks for either member and the real
// clock (./fixtures.ts), so a test needs no clean-up beyond closing the two
// browser contexts it opened.

type FixtureUser = 'Household One' | 'Household Two';

async function signIn(page: Page, user: FixtureUser) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByRole('button', { name: `${user}, account` })).toBeVisible();
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

async function closeContexts(one: Page, two: Page) {
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
    await closeContexts(one, two);
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
    await closeContexts(one, two);
  }
});

test('Two stops sharing One\'s list with a delete question open in All tasks; when One shares it again the task is back without the question (hidden-delete-question AC-1, AC-6)', async ({
  browser,
}, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: garage');
    await addTask(one, 'Shared: oil change');
    await addTask(one, 'Shared: tyres');
    await share(one, 'Shared: garage');
    await two.reload();
    await expect(tab(two, 'All tasks')).toHaveAttribute('aria-selected', 'true');
    await expect(checkbox(two, 'Shared: oil change')).toBeVisible();

    await button(two, 'Delete "Shared: oil change"').click();
    await expect(button(two, 'Confirm deleting "Shared: oil change"')).toBeVisible();
    await openManage(two);
    await button(two, 'Stop sharing "Shared: garage"').click();
    await button(two, 'Confirm stopping sharing "Shared: garage"').click();
    await expect(tablist(two).getByRole('tab', { name: /Shared: garage/ })).toHaveCount(0);
    await expect(two.getByRole('status')).toHaveText(
      '"Shared: garage" is no longer shared with you, so it was removed. "Shared: oil change" is no longer shared with you.',
    );
    await expect(checkbox(two, 'Shared: oil change')).toHaveCount(0);
    await expect(two.getByRole('group', { name: 'Delete "Shared: oil change"?' })).toHaveCount(0);
    await screenshot(two, testInfo, 'hidden-question-after-leave');

    // One shares the list again (stopping sharing it gave it back unshared).
    await nextRefresh(one);
    await expect(tab(one, 'Shared: garage')).toBeVisible();
    await share(one, 'Shared: garage');
    // Two's next refresh brings the list and its tasks back, with no question.
    await nextRefresh(two);
    await expect(sharedTab(two, 'Shared: garage')).toBeVisible();
    await expect(checkbox(two, 'Shared: oil change')).toBeVisible();
    await expect(checkbox(two, 'Shared: tyres')).toBeVisible();
    await expectNoReload(two);
    await expect(two.getByRole('group', { name: 'Delete "Shared: oil change"?' })).toHaveCount(0);
    await expect(button(two, 'Confirm deleting "Shared: oil change"')).toHaveCount(0);
    await expect(button(two, 'Delete "Shared: oil change"')).toBeVisible();
    await screenshot(two, testInfo, 'hidden-question-after-reshare');
  } finally {
    await closeContexts(one, two);
  }
});

test('Two acts on One\'s list after One stopped sharing it or deleted it: Two\'s own task with a delete question leaves when it is not Two\'s, and stays and deletes when it is (hidden-delete-question AC-8)', async ({
  browser,
}, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Shared: workshop');
    await share(one, 'Shared: workshop');
    await createList(one, 'Shared: shed');
    await share(one, 'Shared: shed');
    await two.reload();
    await sharedTab(two, 'Shared: workshop').click();
    await addTask(two, 'Shared: drill');
    await sharedTab(two, 'Shared: shed').click();
    await addTask(two, 'Shared: rake');
    await tab(two, 'All tasks').click();

    // One stops sharing the workshop; Two has not refreshed yet.
    await openManage(one);
    await button(one, 'Stop sharing "Shared: workshop"').click();
    await expect(tab(one, 'Shared: workshop')).toBeVisible();
    await button(two, 'Delete "Shared: drill"').click();
    await expect(button(two, 'Confirm deleting "Shared: drill"')).toBeVisible();
    await openManage(two);
    await button(two, 'Stop sharing "Shared: workshop"').click();
    await button(two, 'Confirm stopping sharing "Shared: workshop"').click();
    await expect(tablist(two).getByRole('tab', { name: /Shared: workshop/ })).toHaveCount(0);
    // The refresh the drop starts shows the task is not Two's: it leaves,
    // with its question, and no ghost row stays.
    await expect(two.getByRole('status')).toHaveText('"Shared: drill" is no longer shared with you.');
    await expect(checkbox(two, 'Shared: drill')).toHaveCount(0);
    await expect(two.getByRole('group', { name: 'Delete "Shared: drill"?' })).toHaveCount(0);
    await screenshot(two, testInfo, 'kept-task-unshared-after-refresh');
    await nextRefresh(two);
    await expectNoReload(two);
    await expect(checkbox(two, 'Shared: rake')).toBeVisible();
    await expect(checkbox(two, 'Shared: drill')).toHaveCount(0);
    await expect(button(two, 'Confirm deleting "Shared: drill"')).toHaveCount(0);
    // One keeps it in the workshop.
    await nextRefresh(one);
    await tab(one, 'Shared: workshop').click();
    await expect(checkbox(one, 'Shared: drill')).toBeVisible();

    // One deletes the shed; Two's task goes to Two's Inbox. Two renames the
    // shed before a refresh, with a question open on that task.
    await button(one, 'Delete list "Shared: shed"').click();
    await button(one, 'Confirm deleting list "Shared: shed"').click();
    await expect(tablist(one).getByRole('tab', { name: /Shared: shed/ })).toHaveCount(0);
    await button(two, 'Delete "Shared: rake"').click();
    await expect(button(two, 'Confirm deleting "Shared: rake"')).toBeVisible();
    await button(two, 'Rename "Shared: shed"').click();
    await two.getByRole('textbox', { name: 'New name for "Shared: shed"' }).fill('Shared: garden shed');
    await two.keyboard.press('Enter');
    await expect(tablist(two).getByRole('tab', { name: /Shared: shed/ })).toHaveCount(0);
    await expect(two.getByRole('status')).toHaveText('"Shared: shed" no longer exists, so it was removed.');
    await nextRefresh(two);
    await expectNoReload(two);
    await expect(checkbox(two, 'Shared: rake')).toBeVisible();
    await expect(button(two, 'Confirm deleting "Shared: rake"')).toBeVisible();
    await expect(two.getByRole('status')).toHaveText('"Shared: shed" no longer exists, so it was removed.');
    await screenshot(two, testInfo, 'kept-task-deleted-after-refresh');
    await button(two, 'Confirm deleting "Shared: rake"').click();
    await expect(checkbox(two, 'Shared: rake')).toHaveCount(0);
    await two.reload();
    await expect(checkbox(two, 'Shared: rake')).toHaveCount(0);
    await expect(checkbox(two, 'Shared: drill')).toHaveCount(0);
  } finally {
    await closeContexts(one, two);
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
    await closeContexts(one, two);
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
    // Earlier files leave Household One with more lists, so this may take a while.
    for (let presses = 0; presses < 200 && !(await toggle.evaluate((element) => element === document.activeElement)); presses++) {
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
    await expect(sharedTab(one, 'Shared: kitchen and pantry restock').locator('svg.lucide-users')).toBeVisible();
    // Reached by keyboard (Shift+Tab back to the tab row), the tab scrolls into
    // view within the row; the page still does not scroll sideways.
    await sharedTab(one, 'Shared: kitchen and pantry restock').focus();
    await expect(sharedTab(one, 'Shared: kitchen and pantry restock')).toBeInViewport();
    expect(await one.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    expect(await one.evaluate(() => window.scrollX)).toBe(0);
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
    await expect(assigned.locator('option:checked')).toHaveText('Me (Household One)');
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
    await closeContexts(one, two);
  }
});
