import type { Browser, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures';

// The "Assigned to me" view in a real browser, with Household One and
// Household Two signed in side by side in separate browser contexts, against
// the Vite dev server and the real API on a disposable database. The criteria
// named below are those of the assigned-to-me task.
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
  await expect(addButton(page)).toBeVisible();
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

const ASSIGNED = 'Assigned to me';
const EMPTY = 'No tasks are assigned to you yet: tasks assigned to you in shared lists show here.';
// The view title is the button that opens the view picker, a menu of the
// views and lists. Its items stay on the page, hidden, while it is closed.
const viewTitle = (page: Page) => page.locator('#view-title');
const viewMenu = (page: Page) => page.getByRole('menu', { name: 'Views and lists', includeHidden: true });
const tab = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitemradio', { name, exact: true, includeHidden: true });
const viewItem = (page: Page, name: RegExp) =>
  viewMenu(page).getByRole('menuitemradio', { name, includeHidden: true });
const menuItem = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitem', { name, exact: true, includeHidden: true });
// Chooses a view, or New list or Manage lists, from the picker.
async function pick(page: Page, name: string) {
  if ((await viewTitle(page).getAttribute('aria-expanded')) !== 'true') await viewTitle(page).click();
  await tab(page, name).or(menuItem(page, name)).click();
  await expect(viewMenu(page)).toBeHidden();
}
const addButton = (page: Page) => page.getByRole('button', { name: 'Add a task', exact: true });
const addSheet = (page: Page) => page.getByRole('dialog', { name: 'New task' });
const newTaskField = (page: Page) => addSheet(page).getByRole('textbox', { name: 'New task', exact: true });
const sharedTab = (page: Page, name: string) => tab(page, `${name} (shared)`);
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const labels = (page: Page, title: string) => rowOf(page, title).locator('[data-share-labels]');
const listLabel = (page: Page, title: string) => rowOf(page, title).locator('[data-list-label]');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const statusMessage = (page: Page) => page.getByRole('status');

async function addTask(page: Page, title: string) {
  await addButton(page).click();
  await newTaskField(page).fill(title);
  await newTaskField(page).press('Enter');
  await expect(checkbox(page, title)).toBeVisible();
  await expect(addButton(page)).toBeFocused();
}
async function createList(page: Page, name: string) {
  await pick(page, 'New list');
  await page.getByRole('textbox', { name: 'List name' }).fill(name);
  await page.getByRole('textbox', { name: 'List name' }).press('Enter');
  await expect(tab(page, name)).toHaveAttribute('aria-checked', 'true');
}
async function share(page: Page, name: string) {
  if (!(await page.getByRole('list', { name: 'Your lists' }).isVisible())) await pick(page, 'Manage lists');
  await button(page, `Share "${name}" with household`).click();
  await expect(sharedTab(page, name)).toBeAttached();
  await button(page, 'Close Manage lists').click();
}
async function assign(page: Page, title: string, to: string) {
  await button(page, `Edit "${title}"`).click();
  await page.getByRole('combobox', { name: `Assigned to, for "${title}"` }).selectOption({ label: to });
  await button(page, 'Save').click();
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

test('Two sees tasks assigned to them across shared lists, live; reassigning one removes it with a notice (AC-1, AC-2, AC-4, AC-6, AC-8)', async ({
  browser,
}, testInfo) => {
  // Two members and many steps: it took 26s of the default 30s before every
  // add went through the + button and every view through the picker.
  test.setTimeout(90_000);
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    // One's shared list with two tasks, and an unshared list.
    await createList(one, 'Assigned: private');
    await addTask(one, 'Assigned: diary');
    await createList(one, 'Assigned: groceries');
    await addTask(one, 'Assigned: oat milk');
    await addTask(one, 'Assigned: eggs');
    await share(one, 'Assigned: groceries');

    // Two opens the view: the tab follows Inbox, and nothing is theirs yet.
    await two.reload();
    await expect(viewMenu(two).getByRole('menuitemradio', { includeHidden: true })).toHaveText([
      'All tasks',
      'Inbox',
      ASSIGNED,
      'Assigned: groceries (shared)',
    ]);
    await pick(two, ASSIGNED);
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-checked', 'true');
    expect(new URL(two.url()).searchParams.get('list')).toBe('assigned');
    await expect(two.getByText(EMPTY)).toBeVisible();
    await screenshot(two, testInfo, 'assigned-empty');

    // One assigns a task to Two: it appears in Two's view on the next
    // refresh, without a reload, with its list and labels. (One's page loaded
    // the members before Two first signed in; a refresh brings Two in.)
    await nextRefresh(one);
    await assign(one, 'Assigned: oat milk', 'Household Two');
    await expect(labels(one, 'Assigned: oat milk')).toHaveText('Assigned to Household Two');
    await nextRefresh(two);
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expectNoReload(two);
    await expect(listLabel(two, 'Assigned: oat milk')).toHaveText('List: Assigned: groceries');
    await expect(labels(two, 'Assigned: oat milk')).toHaveText('Added by Household One · Assigned to you');
    await expect(checkbox(two, 'Assigned: eggs')).toHaveCount(0);
    await expect(two.getByText('Assigned: diary')).toHaveCount(0);

    // A task in Two's own shared list, assigned to Two, shows next to it.
    await createList(two, 'Assigned: garden');
    await share(two, 'Assigned: garden');
    await addTask(two, 'Assigned: rake leaves');
    await assign(two, 'Assigned: rake leaves', 'Me (Household Two)');
    await expect(labels(two, 'Assigned: rake leaves')).toHaveText('Assigned to you');
    // A task in Two's Inbox does not show.
    await pick(two, 'Inbox');
    await addTask(two, 'Assigned: inbox note');
    await pick(two, ASSIGNED);
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeVisible();
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expect(checkbox(two, 'Assigned: inbox note')).toHaveCount(0);
    await expect(listLabel(two, 'Assigned: rake leaves')).toHaveText('List: Assigned: garden');
    await screenshot(two, testInfo, 'assigned-two-lists');

    // A reload keeps the view.
    await two.reload();
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-checked', 'true');
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeVisible();

    // Adding from the view puts the task in Inbox, with a notice.
    await addButton(two).click();
    await newTaskField(two).fill('Assigned: call the plumber');
    await expect(addSheet(two).getByRole('button', { name: /^List: / })).toHaveAccessibleName('List: Inbox');
    await newTaskField(two).press('Enter');
    await expect(statusMessage(two)).toHaveText('Added "Assigned: call the plumber" to Inbox.');
    await expect(checkbox(two, 'Assigned: call the plumber')).toHaveCount(0);

    // Two reassigns One's task to One: it leaves the view with a notice, and
    // focus moves to the other row.
    await assign(two, 'Assigned: oat milk', 'Household One');
    await expect(statusMessage(two)).toHaveText('"Assigned: oat milk" is now assigned to Household One.');
    await expect(checkbox(two, 'Assigned: oat milk')).toHaveCount(0);
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeFocused();
    await screenshot(two, testInfo, 'assigned-reassigned');

    // One sees it is theirs now, in their own view.
    await nextRefresh(one);
    await pick(one, ASSIGNED);
    await expect(checkbox(one, 'Assigned: oat milk')).toBeVisible();
    await expect(labels(one, 'Assigned: oat milk')).toHaveText('Assigned to you');
    await expect(checkbox(one, 'Assigned: rake leaves')).toHaveCount(0);

    // One gives it back to Two, then to nobody: it comes and goes in Two's
    // view on each refresh, and Two's other row stays.
    await assign(one, 'Assigned: oat milk', 'Household Two');
    await expect(statusMessage(one)).toHaveText('"Assigned: oat milk" is now assigned to Household Two.');
    await nextRefresh(two);
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expectNoReload(two);
    await pick(one, 'Assigned: groceries (shared)');
    await assign(one, 'Assigned: oat milk', 'Nobody');
    await expect(labels(one, 'Assigned: oat milk')).toHaveCount(0);
    await nextRefresh(two);
    await expect(checkbox(two, 'Assigned: oat milk')).toHaveCount(0);
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeVisible();
    await expectNoReload(two);
  } finally {
    await closeContexts(one, two);
  }
});

test('the view follows Inbox in the picker and is reached by keyboard; the view survives a reload (AC-1, AC-8; calm-layout AC-2)', async ({ browser }, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Keys: shared');
    await addTask(one, 'Keys: hoover');
    await share(one, 'Keys: shared');
    await assign(one, 'Keys: hoover', 'Me (Household One)');

    await pick(one, 'Inbox');
    // From the title, the down arrow opens the menu at Inbox; the next item is the view.
    await expect(viewTitle(one)).toBeFocused();
    await one.keyboard.press('ArrowDown');
    await expect(tab(one, 'Inbox')).toBeFocused();
    await one.keyboard.press('ArrowDown');
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await one.keyboard.press('ArrowDown');
    await expect(sharedTab(one, 'Keys: shared')).toBeFocused();
    await one.keyboard.press('ArrowUp');
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await one.keyboard.press('Enter');
    await expect(viewTitle(one)).toBeFocused();
    await expect(viewTitle(one)).toHaveText(ASSIGNED);
    await expect(tab(one, ASSIGNED)).toHaveAttribute('aria-checked', 'true');
    expect(new URL(one.url()).searchParams.get('list')).toBe('assigned');
    await expect(checkbox(one, 'Keys: hoover')).toBeVisible();
    await expect(listLabel(one, 'Keys: hoover')).toHaveText('List: Keys: shared');
    // Only the view title is in the Tab order; the menu's items are not.
    await expect(viewMenu(one).locator('[tabindex="0"]')).toHaveCount(0);
    await screenshot(one, testInfo, 'assigned-keyboard');

    // Loading the URL opens the view.
    await one.goto('/?list=assigned');
    await expect(tab(one, ASSIGNED)).toHaveAttribute('aria-checked', 'true');
    await expect(checkbox(one, 'Keys: hoover')).toBeVisible();
    // Two has nothing assigned.
    await two.goto('/?list=assigned');
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-checked', 'true');
    await expect(two.getByText(EMPTY)).toBeVisible();
  } finally {
    await closeContexts(one, two);
  }
});

test('the view picker with "Assigned to me" fits a phone without a page scroll (AC-8; calm-layout AC-1)', async ({ browser }, testInfo) => {
  const one = await member(browser, 'Household One', { width: 390, height: 844 });
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Phone: kitchen and pantry restock');
    await addTask(one, 'Phone: flour');
    await share(one, 'Phone: kitchen and pantry restock');
    await assign(one, 'Phone: flour', 'Me (Household One)');
    await pick(one, ASSIGNED);
    await expect(checkbox(one, 'Phone: flour')).toBeVisible();
    await viewTitle(one).click();
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await expect(tab(one, ASSIGNED)).toBeInViewport();
    const measured = await one.evaluate(() => {
      const menu = document.getElementById('view-menu')!;
      return {
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        menuRight: menu.getBoundingClientRect().right,
        viewport: document.documentElement.clientWidth,
      };
    });
    expect(measured.page).toBe(0);
    expect(measured.menuRight).toBeLessThanOrEqual(measured.viewport);
    expect(await one.evaluate(() => window.scrollX)).toBe(0);
    await screenshot(one, testInfo, 'assigned-phone');
  } finally {
    await closeContexts(one, two);
  }
});
