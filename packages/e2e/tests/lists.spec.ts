import { type APIRequestContext, expect, type Page, type Request, test, type TestInfo } from '@playwright/test';

// Task lists in a real browser against the Vite dev server and the real API
// on a disposable database, signed in through the fixture SSO provider. The
// criteria named below are those of the lists task.
//
// All tests share one database for the run, and this file runs before
// tasks.spec.ts. Household One keeps the lists and tasks each test leaves
// behind, so every test uses its own names and only looks at those. Household
// Two must be left without tasks: tasks.spec.ts expects it to start empty.

type FixtureUser = 'Household One' | 'Household Two';

const apiOrigin = `http://localhost:${process.env.E2E_API_PORT ?? 3173}`;
async function setServerClock(request: APIRequestContext, time: Date | null) {
  const response = await request.put(`${apiOrigin}/e2e/clock`, { data: { time: time?.toISOString() ?? null } });
  expect(response.ok()).toBe(true);
}
test.beforeEach(async ({ request }) => {
  await setServerClock(request, null);
});

async function signIn(page: Page, user: FixtureUser, path = '/') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByText(`Signed in as ${user}`)).toBeVisible();
  await expect(page.getByLabel('New task')).toBeVisible();
}

const tablist = (page: Page) => page.getByRole('tablist', { name: 'Lists' });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const statusMessage = (page: Page) => page.getByRole('status');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const completedToggle = (page: Page) => page.getByRole('button', { name: /^Completed \(\d+\)$/ });
const listParam = (page: Page) => new URL(page.url()).searchParams.get('list');

async function selectedTab(page: Page) {
  return tablist(page).getByRole('tab', { selected: true }).textContent();
}
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
// The titles shown in the task area, top to bottom, among the given ones.
async function shownTitles(page: Page, among: string[]) {
  const all = await page.getByRole('tabpanel').getByRole('list').locator('label').allTextContents();
  return all.filter((title) => among.includes(title));
}
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
// Records the list writes the page sends, to prove that an action sent none.
function recordListWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', (request: Request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && pathname.startsWith('/api/lists')) {
      writes.push(`${request.method()} ${pathname.replace(/\d+$/, ':id')}`);
    }
  });
  return writes;
}

test('creates lists and switches between them with the keyboard only (AC-8, AC-11, AC-15)', async ({ page }, testInfo) => {
  await signIn(page, 'Household One');
  const writes = recordListWrites(page);

  // From the top of the page, the first Tab stop is the selected tab.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  await expect(tab(page, 'All tasks')).toBeFocused();
  await expect(tab(page, 'All tasks')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(button(page, 'New list')).toBeFocused();

  // Escape closes the name field without sending anything.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'List name' })).toBeFocused();
  await page.keyboard.type('Keys: thrown away');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'List name' })).toHaveCount(0);
  await expect(button(page, 'New list')).toBeFocused();
  expect(writes).toEqual([]);

  // Enter creates the list, adds its tab, selects it and focuses it.
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keys: Errands');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Keys: Errands')).toBeFocused();
  await expect(tab(page, 'Keys: Errands')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('No tasks in Keys: Errands yet.')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(button(page, 'New list')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keys: Home');
  await page.keyboard.press('Enter');
  await expect(tab(page, 'Keys: Home')).toBeFocused();
  expect(writes).toEqual(['POST /api/lists', 'POST /api/lists']);
  const homeId = listParam(page);
  expect(homeId).toMatch(/^\d+$/);

  // Arrow keys, Home and End move between tabs and select them.
  await page.keyboard.press('ArrowLeft');
  await expect(tab(page, 'Keys: Errands')).toBeFocused();
  await expect(tab(page, 'Keys: Errands')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('No tasks in Keys: Errands yet.')).toBeVisible();
  await page.keyboard.press('Home');
  await expect(tab(page, 'All tasks')).toBeFocused();
  expect(listParam(page)).toBe('all');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  expect(listParam(page)).toBe('inbox');
  await page.keyboard.press('End');
  await expect(tab(page, 'Keys: Home')).toBeFocused();
  expect(listParam(page)).toBe(homeId);
  // Past the end: back to the first tab.
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'All tasks')).toBeFocused();
  // Only the selected tab is in the Tab order.
  await expect(tablist(page).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  await screenshot(page, testInfo, 'lists-keyboard');
});

test('adds tasks in a named list and in All tasks; views and the URL survive a reload (AC-9, AC-10, AC-15)', async ({
  page,
}, testInfo) => {
  await signIn(page, 'Household One');
  await createList(page, 'Views: Errands');
  const errandsId = listParam(page);
  await expect(page.getByLabel('New task')).toHaveAttribute('placeholder', 'Add to Views: Errands');
  await addTask(page, 'Views: buy stamps');

  await tab(page, 'All tasks').click();
  await expect(page.getByLabel('New task')).toHaveAttribute('placeholder', 'Add to Inbox');
  await addTask(page, 'Views: call the plumber');
  const titles = ['Views: buy stamps', 'Views: call the plumber'];
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber', 'Views: buy stamps']);
  // In All tasks, the row in a named list names it; the Inbox row does not.
  await expect(rowOf(page, 'Views: buy stamps').locator('[data-list-label]')).toHaveText('List: Views: Errands');
  await expect(rowOf(page, 'Views: call the plumber').locator('[data-list-label]')).toHaveCount(0);
  await screenshot(page, testInfo, 'lists-all-tasks-labels');

  await tab(page, 'Views: Errands').click();
  expect(listParam(page)).toBe(errandsId);
  await page.reload();
  await expect(tab(page, 'Views: Errands')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: buy stamps']);
  await expect(rowOf(page, 'Views: buy stamps').locator('[data-list-label]')).toHaveCount(0);

  await tab(page, 'Inbox').click();
  await page.reload();
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  expect(listParam(page)).toBe('inbox');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber']);

  // An unknown list in the URL shows All tasks.
  await page.goto('/?list=2147483000');
  await expect(tab(page, 'All tasks')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber', 'Views: buy stamps']);
});

test('moves a task between lists from the edit row (AC-13, AC-15)', async ({ page }, testInfo) => {
  await signIn(page, 'Household One');
  await createList(page, 'Move: Groceries');
  await createList(page, 'Move: Hardware');
  await tab(page, 'Inbox').click();
  await addTask(page, 'Move: oat milk');
  await addTask(page, 'Move: light bulbs');

  await button(page, 'Edit "Move: oat milk"').click();
  const select = page.getByRole('combobox', { name: 'List for "Move: oat milk"' });
  await expect(select).toHaveValue('');
  await select.selectOption({ label: 'Move: Groceries' });
  await screenshot(page, testInfo, 'lists-edit-row-select');
  await button(page, 'Save').click();
  await expect(statusMessage(page)).toHaveText('Moved "Move: oat milk" to Move: Groceries.');
  await expect(checkbox(page, 'Move: oat milk')).toHaveCount(0);
  // Focus moved on to a row's checkbox, as after a delete (Inbox also holds
  // tasks earlier tests left, so which row comes next is not fixed here).
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-action')))
    .toBe('toggle');

  await tab(page, 'Move: Groceries').click();
  await expect(checkbox(page, 'Move: oat milk')).toBeVisible();
  // From one named list to another.
  await button(page, 'Edit "Move: oat milk"').click();
  await page.getByRole('combobox', { name: 'List for "Move: oat milk"' }).selectOption({ label: 'Move: Hardware' });
  await page.getByRole('combobox', { name: 'List for "Move: oat milk"' }).press('Tab');
  await page.keyboard.press('Control+Enter');
  await expect(statusMessage(page)).toHaveText('Moved "Move: oat milk" to Move: Hardware.');
  await expect(page.getByText('No tasks in Move: Groceries yet.')).toBeVisible();

  await page.reload();
  await tab(page, 'Move: Hardware').click();
  await expect(checkbox(page, 'Move: oat milk')).toBeVisible();
  await tab(page, 'All tasks').click();
  await expect(rowOf(page, 'Move: oat milk').locator('[data-list-label]')).toHaveText('List: Move: Hardware');
});

test('renames a list and deletes a list with tasks, which move to Inbox (AC-12, AC-15)', async ({ page }, testInfo) => {
  await signIn(page, 'Household One');
  await createList(page, 'Manage: Chores');
  await addTask(page, 'Manage: hoover');
  await addTask(page, 'Manage: dust');
  await checkbox(page, 'Manage: dust').click();
  await expect(statusMessage(page)).toHaveText('"Manage: dust" was moved to Completed.');

  await openManage(page);
  await button(page, 'Rename "Manage: Chores"').click();
  const field = page.getByRole('textbox', { name: 'New name for "Manage: Chores"' });
  await expect(field).toBeFocused();
  await field.fill('Manage: Housework');
  await field.press('Enter');
  await expect(tab(page, 'Manage: Housework')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Manage: Chores')).toHaveCount(0);
  await expect(button(page, 'Rename "Manage: Housework"')).toBeFocused();
  await tab(page, 'All tasks').click();
  await expect(rowOf(page, 'Manage: hoover').locator('[data-list-label]')).toHaveText('List: Manage: Housework');
  await tab(page, 'Manage: Housework').click();

  await button(page, 'Delete list "Manage: Housework"').click();
  const question = page.getByRole('group', { name: 'Delete list "Manage: Housework"?' });
  await expect(question).toContainText('Delete Manage: Housework? Its 2 tasks will move to Inbox.');
  await screenshot(page, testInfo, 'lists-delete-confirmation');
  await question.getByRole('button', { name: 'Confirm deleting list "Manage: Housework"' }).click();
  await expect(tab(page, 'Manage: Housework')).toHaveCount(0);
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  expect(listParam(page)).toBe('inbox');
  await expect(checkbox(page, 'Manage: hoover')).toBeVisible();
  await completedToggle(page).click();
  await expect(checkbox(page, 'Manage: dust')).toBeChecked();
  await screenshot(page, testInfo, 'lists-after-delete-inbox');

  await page.reload();
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true');
  await expect(checkbox(page, 'Manage: hoover')).toBeVisible();
});

test('a second user sees none of the first user\'s lists (AC-4, AC-15)', async ({ page, browser }) => {
  await signIn(page, 'Household One');
  await createList(page, 'Private: one only');
  const id = listParam(page);

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, 'Household Two', `/?list=${id}`);
  await expect(tab(other, 'All tasks')).toHaveAttribute('aria-selected', 'true');
  await expect(tablist(other).getByRole('tab')).toHaveText(['All tasks', 'Inbox']);
  await expect(other.getByText('Private: one only')).toHaveCount(0);
  await expect(button(other, 'Manage lists')).toHaveCount(0);

  // Two can use the same name; One still sees only its own list.
  await createList(other, 'Private: one only');
  await page.reload();
  await expect(tablist(page).getByRole('tab', { name: 'Private: one only', exact: true })).toHaveCount(1);
  // Leave Household Two as it was.
  await openManage(other);
  await button(other, 'Delete list "Private: one only"').click();
  await button(other, 'Confirm deleting list "Private: one only"').click();
  await expect(tablist(other).getByRole('tab')).toHaveText(['All tasks', 'Inbox']);
  await otherContext.close();
});

test.describe('lists and repeating tasks', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test('the next occurrence of a repeating task is in the same list (AC-6, AC-15)', async ({ page, request }, testInfo) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC), on both clocks.
    const noon = new Date('2026-11-20T12:00:00-05:00');
    await page.clock.install({ time: noon });
    await setServerClock(request, noon);
    await signIn(page, 'Household One');
    await createList(page, 'Repeat: Garden');
    const title = 'Repeat: water the roses';
    await page.getByLabel('New task').fill(title);
    await page.getByLabel('Due date', { exact: true }).fill('2026-11-20');
    await page.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption({ label: 'Weekly' });
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(checkbox(page, title)).toHaveCount(1);

    await checkbox(page, title).click();
    await expect(statusMessage(page)).toHaveText(`"${title}" is next due Fri, Nov 27.`);
    // Still in the list's view: the next occurrence, and the completed one.
    await expect(page.getByRole('list', { name: 'Upcoming' }).getByRole('checkbox', { name: title })).toBeVisible();
    await completedToggle(page).click();
    await expect(checkbox(page, title)).toHaveCount(2);
    await screenshot(page, testInfo, 'lists-repeat-next-occurrence');

    await page.reload();
    await expect(tab(page, 'Repeat: Garden')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('list', { name: 'Upcoming' }).getByRole('checkbox', { name: title })).toBeVisible();
    await tab(page, 'Inbox').click();
    await expect(checkbox(page, title)).toHaveCount(0);
  });
});

test.describe('lists on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the tab row scrolls sideways inside itself without a page scroll (AC-8, AC-15)', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    for (const name of ['Phone: Groceries for the week', 'Phone: Birthday party plans', 'Phone: Garden and garage']) {
      await createList(page, name);
    }
    const sizes = () =>
      page.evaluate(() => {
        const row = document.querySelector('[role="tablist"]')!;
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rowOverflow: row.scrollWidth - row.clientWidth,
          rowScroll: row.scrollLeft,
          rowRight: row.getBoundingClientRect().right,
          viewport: document.documentElement.clientWidth,
        };
      });
    // The newest tab is selected and scrolled into view inside the row.
    let measured = await sizes();
    expect(measured.page).toBe(0);
    expect(measured.rowOverflow).toBeGreaterThan(0);
    expect(measured.rowRight).toBeLessThanOrEqual(measured.viewport);
    await expect(tab(page, 'Phone: Garden and garage')).toBeInViewport();
    await screenshot(page, testInfo, 'lists-phone-scrolled-end');

    // Home scrolls the row back to the start; the page itself never scrolls sideways.
    await tab(page, 'Phone: Garden and garage').focus();
    await page.keyboard.press('Home');
    await expect(tab(page, 'All tasks')).toBeFocused();
    await expect(tab(page, 'All tasks')).toBeInViewport();
    measured = await sizes();
    expect(measured.rowScroll).toBe(0);
    expect(measured.page).toBe(0);
    await page.mouse.wheel(0, 0);
    await screenshot(page, testInfo, 'lists-phone-start');
    expect(await page.evaluate(() => window.scrollX)).toBe(0);
  });

  test('the edit row stays inside its row with a 50 character list name (AC-13, AC-8)', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    // The longest valid name, in wide letters.
    const name = 'Phone: Weekly paperwork and appointments WWWWWWWWW';
    expect([...name]).toHaveLength(50);
    await createList(page, name);
    const title = 'Phone: file the forms';
    await addTask(page, title);
    await button(page, `Edit "${title}"`).click();
    const select = page.getByRole('combobox', { name: `List for "${title}"` });
    await expect(select).toHaveValue(/^\d+$/);
    // Every control of the edit row, the List select included, lies within the
    // row, and the page has no sideways scroll to hide anything behind.
    const measured = await select.evaluate((element) => {
      const row = element.closest('li')!;
      const box = (target: Element) => {
        const { left, right } = target.getBoundingClientRect();
        return { left: Math.round(left), right: Math.round(right) };
      };
      return {
        row: box(row),
        controls: [...row.querySelectorAll('input, select, textarea, button')].map((control) => ({
          name: control.getAttribute('aria-label') ?? control.textContent ?? '',
          ...box(control),
        })),
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(measured.controls.map((control) => control.name)).toContain(`List for "${title}"`);
    for (const control of measured.controls) {
      expect(control.left, `${control.name} left edge`).toBeGreaterThanOrEqual(measured.row.left);
      expect(control.right, `${control.name} right edge`).toBeLessThanOrEqual(measured.row.right);
    }
    expect(measured.page).toBe(0);
    await screenshot(page, testInfo, 'lists-phone-edit-row');
  });
});
