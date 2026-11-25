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

const ASSIGNED = 'Assigned to me';
const EMPTY = 'No tasks are assigned to you yet: tasks assigned to you in shared lists show here.';
const tablist = (page: Page) => page.getByRole('tablist', { name: 'Lists' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const sharedTab = (page: Page, name: string) => tab(page, `${name} (shared)`);
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const labels = (page: Page, title: string) => rowOf(page, title).locator('[data-share-labels]');
const listLabel = (page: Page, title: string) => rowOf(page, title).locator('[data-list-label]');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const statusMessage = (page: Page) => page.getByRole('status');

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
async function share(page: Page, name: string) {
  if ((await button(page, 'Manage lists').getAttribute('aria-expanded')) !== 'true') {
    await button(page, 'Manage lists').click();
  }
  await button(page, `Share "${name}" with household`).click();
  await expect(sharedTab(page, name)).toBeVisible();
  await button(page, 'Manage lists').click();
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
    await expect(tablist(two).getByRole('tab')).toHaveText(['All tasks', 'Inbox', ASSIGNED, 'Assigned: groceries (shared)']);
    await tab(two, ASSIGNED).click();
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-selected', 'true');
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
    await tab(two, 'Inbox').click();
    await addTask(two, 'Assigned: inbox note');
    await tab(two, ASSIGNED).click();
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeVisible();
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expect(checkbox(two, 'Assigned: inbox note')).toHaveCount(0);
    await expect(listLabel(two, 'Assigned: rake leaves')).toHaveText('List: Assigned: garden');
    await screenshot(two, testInfo, 'assigned-two-lists');

    // A reload keeps the view.
    await two.reload();
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-selected', 'true');
    await expect(checkbox(two, 'Assigned: oat milk')).toBeVisible();
    await expect(checkbox(two, 'Assigned: rake leaves')).toBeVisible();

    // Adding from the view puts the task in Inbox, with a notice.
    await two.getByLabel('New task').fill('Assigned: call the plumber');
    await expect(two.getByLabel('New task')).toHaveAttribute('placeholder', 'Add to Inbox');
    await two.getByLabel('New task').press('Enter');
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
    await tab(one, ASSIGNED).click();
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
    await sharedTab(one, 'Assigned: groceries').click();
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

test('the tab is in the keyboard tab order after Inbox; the view survives a reload (AC-1, AC-8)', async ({ browser }, testInfo) => {
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Keys: shared');
    await addTask(one, 'Keys: hoover');
    await share(one, 'Keys: shared');
    await assign(one, 'Keys: hoover', 'Me (Household One)');

    await tab(one, 'All tasks').click();
    await tab(one, 'Inbox').focus();
    await one.keyboard.press('Enter');
    await one.keyboard.press('ArrowRight');
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await expect(tab(one, ASSIGNED)).toHaveAttribute('aria-selected', 'true');
    expect(new URL(one.url()).searchParams.get('list')).toBe('assigned');
    await expect(checkbox(one, 'Keys: hoover')).toBeVisible();
    await expect(listLabel(one, 'Keys: hoover')).toHaveText('List: Keys: shared');
    // Only the selected tab is in the Tab order.
    await expect(tablist(one).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
    await expect(tab(one, ASSIGNED)).toHaveAttribute('tabindex', '0');
    await one.keyboard.press('ArrowRight');
    await expect(sharedTab(one, 'Keys: shared')).toBeFocused();
    await one.keyboard.press('ArrowLeft');
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await one.keyboard.press('ArrowLeft');
    await expect(tab(one, 'Inbox')).toBeFocused();
    await one.keyboard.press('End');
    await one.keyboard.press('ArrowLeft');
    await expect(tab(one, ASSIGNED)).toBeFocused();
    await screenshot(one, testInfo, 'assigned-keyboard');

    // Loading the URL opens the view.
    await one.goto('/?list=assigned');
    await expect(tab(one, ASSIGNED)).toHaveAttribute('aria-selected', 'true');
    await expect(checkbox(one, 'Keys: hoover')).toBeVisible();
    // Two has nothing assigned.
    await two.goto('/?list=assigned');
    await expect(tab(two, ASSIGNED)).toHaveAttribute('aria-selected', 'true');
    await expect(two.getByText(EMPTY)).toBeVisible();
  } finally {
    await closeContexts(one, two);
  }
});

test('the tab row with "Assigned to me" fits a phone without a page scroll (AC-8)', async ({ browser }, testInfo) => {
  const one = await member(browser, 'Household One', { width: 390, height: 844 });
  const two = await member(browser, 'Household Two');
  try {
    await createList(one, 'Phone: kitchen and pantry restock');
    await addTask(one, 'Phone: flour');
    await share(one, 'Phone: kitchen and pantry restock');
    await assign(one, 'Phone: flour', 'Me (Household One)');
    await tab(one, ASSIGNED).click();
    await expect(checkbox(one, 'Phone: flour')).toBeVisible();
    await tab(one, ASSIGNED).focus();
    await expect(tab(one, ASSIGNED)).toBeInViewport();
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
    expect(await one.evaluate(() => window.scrollX)).toBe(0);
    await screenshot(one, testInfo, 'assigned-phone');
  } finally {
    await closeContexts(one, two);
  }
});
