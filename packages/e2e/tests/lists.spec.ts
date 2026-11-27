import type { Page, Request, TestInfo } from '@playwright/test';
import { expect, setServerClock, test } from './fixtures';

// Task lists in a real browser against the Vite dev server and the real API
// on a disposable database, signed in through the fixture SSO provider. The
// criteria named below are those of the lists task.
//
// Every test starts with no lists or tasks and the real clock on both sides
// (./fixtures.ts).

type FixtureUser = 'Household One' | 'Household Two';


async function signIn(page: Page, user: FixtureUser, path = '/') {
  await page.goto(path);
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByRole('button', { name: `${user}, account` })).toBeVisible();
  await expect(addButton(page)).toBeVisible();
}

// The view title is the button that opens the view picker, a menu of the
// views and lists. Its items stay on the page, hidden, while it is closed.
const viewTitle = (page: Page) => page.locator('#view-title');
const viewMenu = (page: Page) => page.getByRole('menu', { name: 'Views and lists', includeHidden: true });
const tab = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitemradio', { name, exact: true, includeHidden: true });
const viewItems = (page: Page) => viewMenu(page).getByRole('menuitemradio', { includeHidden: true });
const menuItem = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitem', { name, exact: true, includeHidden: true });
// Chooses a view, or New list or Manage lists, from the picker.
async function pick(page: Page, name: string) {
  if ((await viewTitle(page).getAttribute('aria-expanded')) !== 'true') await viewTitle(page).click();
  const item = tab(page, name).or(menuItem(page, name));
  await item.click();
  await expect(viewMenu(page)).toBeHidden();
}
const addButton = (page: Page) => page.getByRole('button', { name: 'Add a task', exact: true });
const addSheet = (page: Page) => page.getByRole('dialog', { name: 'New task' });
const newTaskField = (page: Page) => addSheet(page).getByRole('textbox', { name: 'New task', exact: true });
const chip = (page: Page, name: string) => addSheet(page).getByRole('button', { name: new RegExp(`^${name}: `) });
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const statusMessage = (page: Page) => page.getByRole('status');
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const completedToggle = (page: Page) => page.getByRole('button', { name: /^(Show \d+ done|Hide done)$/ });
const listParam = (page: Page) => new URL(page.url()).searchParams.get('list');

async function addTask(page: Page, title: string) {
  await addButton(page).click();
  await newTaskField(page).fill(title);
  await newTaskField(page).press('Enter');
  await expect(checkbox(page, title)).toBeVisible();
  await expect(addButton(page)).toBeFocused();
}
// Where the add sheet adds now, as its List chip says.
async function addDestination(page: Page) {
  await addButton(page).click();
  const name = await chip(page, 'List').getAttribute('aria-label');
  await page.keyboard.press('Escape');
  await expect(addSheet(page)).toHaveCount(0);
  return name;
}
async function createList(page: Page, name: string) {
  await pick(page, 'New list');
  await page.getByRole('textbox', { name: 'List name' }).fill(name);
  await page.getByRole('textbox', { name: 'List name' }).press('Enter');
  await expect(tab(page, name)).toHaveAttribute('aria-checked', 'true');
  await expect(viewTitle(page)).toHaveText(name);
}
async function openManage(page: Page) {
  if (!(await page.getByRole('list', { name: 'Your lists' }).isVisible())) await pick(page, 'Manage lists');
  await expect(page.getByRole('list', { name: 'Your lists' })).toBeVisible();
}
// The titles shown in the task area, top to bottom, among the given ones.
async function shownTitles(page: Page, among: string[]) {
  const all = await page.getByRole('main').getByRole('list').locator('label').allTextContents();
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

test('creates lists and switches between them with the keyboard only, through the view picker (AC-8, AC-11, AC-15; calm-layout AC-2, AC-3)', async ({ page }, testInfo) => {
  await signIn(page, 'Household One');
  const writes = recordListWrites(page);

  // From the top of the page, the first Tab stop is the skip link, and the
  // next one is the view title, which opens the picker.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to tasks' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(viewTitle(page)).toBeFocused();
  await expect(viewTitle(page)).toHaveText('All tasks');
  await expect(viewTitle(page)).toHaveAttribute('aria-haspopup', 'menu');
  await expect(viewTitle(page)).toHaveAttribute('aria-expanded', 'false');

  // Enter opens it at the checked view; End reaches New list (no lists yet).
  await page.keyboard.press('Enter');
  await expect(viewTitle(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(tab(page, 'All tasks')).toBeFocused();
  await expect(tab(page, 'All tasks')).toHaveAttribute('aria-checked', 'true');
  await expect(menuItem(page, 'Manage lists')).toHaveCount(0);
  await page.keyboard.press('End');
  await expect(menuItem(page, 'New list')).toBeFocused();

  // Escape closes the name field without sending anything; focus goes to the view title.
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'List name' })).toBeFocused();
  await page.keyboard.type('Keys: thrown away');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('textbox', { name: 'List name' })).toHaveCount(0);
  await expect(viewTitle(page)).toBeFocused();
  expect(writes).toEqual([]);

  // A fullwidth "Inbox" folds to "inbox": refused on the field, nothing sent.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('\uff29\uff4e\uff42\uff4f\uff58');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('"Inbox", "All tasks" and "Assigned to me" are built in. Choose another name.');
  await expect(page.getByRole('textbox', { name: 'List name' })).toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Escape');
  await expect(viewTitle(page)).toBeFocused();
  expect(writes).toEqual([]);

  // Enter creates the list and shows it; focus is on the view title, which names it.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keys: Errands');
  await page.keyboard.press('Enter');
  await expect(viewTitle(page)).toBeFocused();
  await expect(viewTitle(page)).toHaveText('Keys: Errands');
  await expect(tab(page, 'Keys: Errands')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('No tasks in Keys: Errands yet.')).toBeVisible();
  // Now there is a list to manage: the last item is Manage lists, New list before it.
  await page.keyboard.press('Enter');
  await page.keyboard.press('End');
  await expect(menuItem(page, 'Manage lists')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menuItem(page, 'New list')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Keys: Home');
  await page.keyboard.press('Enter');
  await expect(viewTitle(page)).toHaveText('Keys: Home');
  await expect(viewTitle(page)).toBeFocused();
  expect(writes).toEqual(['POST /api/lists', 'POST /api/lists']);
  const homeId = listParam(page);
  expect(homeId).toMatch(/^\d+$/);

  // Arrow keys, Home and End move between the items; Enter or Space chooses.
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'Keys: Home')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(tab(page, 'Keys: Errands')).toBeFocused();
  // Moving does not choose.
  expect(listParam(page)).toBe(homeId);
  await page.keyboard.press('Enter');
  await expect(viewTitle(page)).toHaveText('Keys: Errands');
  await expect(page.getByText('No tasks in Keys: Errands yet.')).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await expect(tab(page, 'All tasks')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(viewTitle(page)).toHaveText('All tasks');
  expect(listParam(page)).toBe('all');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  expect(listParam(page)).toBe('inbox');
  await page.keyboard.press('ArrowUp');
  // Past the start: the last item, then back to the first.
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowUp');
  await expect(menuItem(page, 'Manage lists')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tab(page, 'All tasks')).toBeFocused();
  // Escape closes the menu without choosing.
  await page.keyboard.press('Escape');
  await expect(viewMenu(page)).toBeHidden();
  await expect(viewTitle(page)).toBeFocused();
  expect(listParam(page)).toBe('inbox');
  await screenshot(page, testInfo, 'lists-keyboard');
});

test('adds tasks in a named list and in All tasks; views and the URL survive a reload (AC-9, AC-10, AC-15)', async ({
  page,
}, testInfo) => {
  await signIn(page, 'Household One');
  await createList(page, 'Views: Errands');
  const errandsId = listParam(page);
  expect(await addDestination(page)).toBe('List: Views: Errands');
  await addTask(page, 'Views: buy stamps');

  await pick(page, 'All tasks');
  expect(await addDestination(page)).toBe('List: Inbox');
  await addTask(page, 'Views: call the plumber');
  const titles = ['Views: buy stamps', 'Views: call the plumber'];
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber', 'Views: buy stamps']);
  // In All tasks, the row in a named list names it; the Inbox row does not.
  await expect(rowOf(page, 'Views: buy stamps').locator('[data-list-label]')).toHaveText('List: Views: Errands');
  await expect(rowOf(page, 'Views: call the plumber').locator('[data-list-label]')).toHaveCount(0);
  await screenshot(page, testInfo, 'lists-all-tasks-labels');

  await pick(page, 'Views: Errands');
  expect(listParam(page)).toBe(errandsId);
  await page.reload();
  await expect(tab(page, 'Views: Errands')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: buy stamps']);
  await expect(rowOf(page, 'Views: buy stamps').locator('[data-list-label]')).toHaveCount(0);

  await pick(page, 'Inbox');
  await page.reload();
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-checked', 'true');
  expect(listParam(page)).toBe('inbox');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber']);

  // An unknown list in the URL shows All tasks.
  await page.goto('/?list=2147483000');
  await expect(tab(page, 'All tasks')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => shownTitles(page, titles)).toEqual(['Views: call the plumber', 'Views: buy stamps']);
});

test('moves a task between lists from the edit row (AC-13, AC-15)', async ({ page }, testInfo) => {
  await signIn(page, 'Household One');
  await createList(page, 'Move: Groceries');
  await createList(page, 'Move: Hardware');
  await pick(page, 'Inbox');
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

  await pick(page, 'Move: Groceries');
  await expect(checkbox(page, 'Move: oat milk')).toBeVisible();
  // From one named list to another.
  await button(page, 'Edit "Move: oat milk"').click();
  await page.getByRole('combobox', { name: 'List for "Move: oat milk"' }).selectOption({ label: 'Move: Hardware' });
  await page.getByRole('combobox', { name: 'List for "Move: oat milk"' }).press('Tab');
  await page.keyboard.press('Control+Enter');
  await expect(statusMessage(page)).toHaveText('Moved "Move: oat milk" to Move: Hardware.');
  await expect(page.getByText('No tasks in Move: Groceries yet.')).toBeVisible();

  await page.reload();
  await pick(page, 'Move: Hardware');
  await expect(checkbox(page, 'Move: oat milk')).toBeVisible();
  await pick(page, 'All tasks');
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
  await expect(tab(page, 'Manage: Housework')).toHaveAttribute('aria-checked', 'true');
  await expect(tab(page, 'Manage: Chores')).toHaveCount(0);
  await expect(button(page, 'Rename "Manage: Housework"')).toBeFocused();
  await pick(page, 'All tasks');
  await expect(rowOf(page, 'Manage: hoover').locator('[data-list-label]')).toHaveText('List: Manage: Housework');
  await pick(page, 'Manage: Housework');

  await button(page, 'Delete list "Manage: Housework"').click();
  const question = page.getByRole('group', { name: 'Delete list "Manage: Housework"?' });
  await expect(question).toContainText('Delete Manage: Housework? Its 2 tasks will move to Inbox.');
  await screenshot(page, testInfo, 'lists-delete-confirmation');
  await question.getByRole('button', { name: 'Confirm deleting list "Manage: Housework"' }).click();
  await expect(tab(page, 'Manage: Housework')).toHaveCount(0);
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-checked', 'true');
  expect(listParam(page)).toBe('inbox');
  await expect(checkbox(page, 'Manage: hoover')).toBeVisible();
  await completedToggle(page).click();
  await expect(checkbox(page, 'Manage: dust')).toBeChecked();
  await screenshot(page, testInfo, 'lists-after-delete-inbox');

  await page.reload();
  await expect(tab(page, 'Inbox')).toHaveAttribute('aria-checked', 'true');
  await expect(checkbox(page, 'Manage: hoover')).toBeVisible();
});

test('a second user sees none of the first user\'s lists (AC-4, AC-15)', async ({ page, browser }) => {
  await signIn(page, 'Household One');
  await createList(page, 'Private: one only');
  const id = listParam(page);

  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, 'Household Two', `/?list=${id}`);
  await expect(tab(other, 'All tasks')).toHaveAttribute('aria-checked', 'true');
  await expect(viewItems(other)).toHaveText(['All tasks', 'Inbox', 'Assigned to me']);
  await expect(other.getByText('Private: one only')).toHaveCount(0);
  await expect(menuItem(other, 'Manage lists')).toHaveCount(0);

  // Two can use the same name; One still sees only its own list.
  await createList(other, 'Private: one only');
  await page.reload();
  await expect(tab(page, 'Private: one only')).toHaveCount(1);
  // Leave Household Two as it was.
  await openManage(other);
  await button(other, 'Delete list "Private: one only"').click();
  await button(other, 'Confirm deleting list "Private: one only"').click();
  await expect(viewItems(other)).toHaveText(['All tasks', 'Inbox', 'Assigned to me']);
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
    await addButton(page).click();
    await newTaskField(page).fill(title);
    await chip(page, 'Due date').click();
    await addSheet(page).getByLabel('Due date', { exact: true }).fill('2026-11-20');
    await chip(page, 'Repeat').click();
    await page.getByRole('combobox', { name: 'Repeats', exact: true }).selectOption({ label: 'Weekly' });
    // The List chip says where it goes: the list shown.
    await expect(chip(page, 'List')).toHaveAccessibleName('List: Repeat: Garden');
    await addSheet(page).getByRole('button', { name: 'Add task' }).click();
    await expect(checkbox(page, title)).toHaveCount(1);

    await checkbox(page, title).click();
    await expect(statusMessage(page)).toHaveText(`"${title}" is next due Fri, Nov 27.`);
    // Still in the list's view: the next occurrence, and the completed one.
    await expect(page.getByRole('list', { name: 'Upcoming' }).getByRole('checkbox', { name: title })).toBeVisible();
    await completedToggle(page).click();
    await expect(checkbox(page, title)).toHaveCount(2);
    await screenshot(page, testInfo, 'lists-repeat-next-occurrence');

    await page.reload();
    await expect(tab(page, 'Repeat: Garden')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('list', { name: 'Upcoming' }).getByRole('checkbox', { name: title })).toBeVisible();
    await pick(page, 'Inbox');
    await expect(checkbox(page, title)).toHaveCount(0);
  });
});

test.describe('lists on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the view picker with long list names fits a phone without a page scroll (AC-8, AC-15; calm-layout AC-1, AC-2)', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    for (const name of ['Phone: Groceries for the week', 'Phone: Birthday party plans', 'Phone: Garden and garage']) {
      await createList(page, name);
    }
    const sizes = () =>
      page.evaluate(() => {
        const menu = document.getElementById('view-menu')!.getBoundingClientRect();
        return {
          page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          menuLeft: menu.left,
          menuRight: menu.right,
          viewport: document.documentElement.clientWidth,
        };
      });
    await viewTitle(page).click();
    await expect(tab(page, 'Phone: Garden and garage')).toBeFocused();
    await expect(tab(page, 'Phone: Garden and garage')).toBeInViewport();
    const measured = await sizes();
    expect(measured.page).toBe(0);
    expect(measured.menuLeft).toBeGreaterThanOrEqual(0);
    expect(measured.menuRight).toBeLessThanOrEqual(measured.viewport);
    await screenshot(page, testInfo, 'lists-phone-picker');

    // Home reaches the first item; the page itself never scrolls sideways.
    await page.keyboard.press('Home');
    await expect(tab(page, 'All tasks')).toBeFocused();
    await expect(tab(page, 'All tasks')).toBeInViewport();
    expect((await sizes()).page).toBe(0);
    await page.keyboard.press('Escape');
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

    // Remove the task and the list again. tasks.spec.ts runs later as
    // Household One, and with this task left in "No date" its edit row test
    // that resizes the window ("sets a repeat by pointer") missed its Save
    // click: that test depends on the rows around it.
    await button(page, 'Cancel').click();
    await button(page, `Delete "${title}"`).click();
    await page.getByRole('button', { name: `Confirm deleting "${title}"`, exact: true }).click();
    await expect(checkbox(page, title)).toHaveCount(0);
    await openManage(page);
    await button(page, `Delete list "${name}"`).click();
    await page.getByRole('button', { name: `Confirm deleting list "${name}"`, exact: true }).click();
    await expect(tab(page, name)).toHaveCount(0);
  });
});
