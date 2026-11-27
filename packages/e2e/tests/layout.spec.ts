import type { Browser, Page, Request, TestInfo } from '@playwright/test';
import { expect, setServerClock, test } from './fixtures';

// The calm layout in a real browser against the Vite dev server and the real
// API on a disposable database: one column, the view title that opens the
// view picker, the + button and its add sheet with chips, the "Show N done"
// toggle, and where focus goes when a control it was on leaves the page. The
// criteria named below are those of the calm-layout task.
//
// Every test starts with no lists or tasks and the real clock on both sides
// (./fixtures.ts).

type FixtureUser = 'Household One' | 'Household Two';

async function signIn(page: Page, user: FixtureUser) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByRole('button', { name: `${user}, account` })).toBeVisible();
  await expect(addButton(page)).toBeVisible();
}
// A member in their own browser context, with the page clock installed (it
// keeps running at the real pace) so a test can jump to the next 30-second
// refresh instead of waiting for it.
async function member(browser: Browser, user: FixtureUser, viewport?: { width: number; height: number }) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  await page.clock.install();
  await signIn(page, user);
  return page;
}
async function nextRefresh(page: Page) {
  await page.clock.fastForward(30_000);
}

const viewTitle = (page: Page) => page.locator('#view-title');
const viewMenu = (page: Page) => page.getByRole('menu', { name: 'Views and lists', includeHidden: true });
const viewItem = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitemradio', { name, exact: true, includeHidden: true });
const menuItem = (page: Page, name: string) =>
  viewMenu(page).getByRole('menuitem', { name, exact: true, includeHidden: true });
async function pick(page: Page, name: string) {
  if ((await viewTitle(page).getAttribute('aria-expanded')) !== 'true') await viewTitle(page).click();
  await viewItem(page, name).or(menuItem(page, name)).click();
  await expect(viewMenu(page)).toBeHidden();
}
const addButton = (page: Page) => page.getByRole('button', { name: 'Add a task', exact: true });
const addSheet = (page: Page) => page.getByRole('dialog', { name: 'New task' });
const newTaskField = (page: Page) => addSheet(page).getByRole('textbox', { name: 'New task', exact: true });
const chip = (page: Page, name: string) => addSheet(page).getByRole('button', { name: new RegExp(`^${name}: `) });
const sheetButton = (page: Page, name: string) => addSheet(page).getByRole('button', { name, exact: true });
const checkbox = (page: Page, title: string) => page.getByRole('checkbox', { name: title, exact: true });
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
  await expect(viewTitle(page)).toHaveText(name);
}
async function share(page: Page, name: string) {
  await pick(page, 'Manage lists');
  await button(page, `Share "${name}" with household`).click();
  await expect(viewItem(page, `${name} (shared)`)).toBeAttached();
  await button(page, 'Close Manage lists').click();
}
// The bodies of the task creations the page sends.
function recordCreates(page: Page) {
  const bodies: unknown[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}
async function screenshot(page: Page, testInfo: TestInfo, name: string, fullPage = false) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
async function activeName(page: Page) {
  return page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.id || active?.getAttribute('aria-label') || active?.textContent || null;
  });
}

test.describe('the add sheet', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test.beforeEach(async ({ page, request }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC), on both clocks.
    const noon = new Date('2026-11-20T12:00:00-05:00');
    await page.clock.install({ time: noon });
    await setServerClock(request, noon);
  });

  test('opens from the + button with focus in the title, keeps Tab inside, and closes with Escape, Cancel and the backdrop, keeping the draft (AC-4)', async ({
    page,
  }, testInfo) => {
    await signIn(page, 'Household One');
    const bodies = recordCreates(page);
    await expect(addButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
    await addButton(page).click();
    await expect(addSheet(page)).toBeVisible();
    await expect(addSheet(page)).toHaveAttribute('aria-modal', 'true');
    await expect(newTaskField(page)).toBeFocused();
    await screenshot(page, testInfo, 'sheet-open');

    // Tab and Shift+Tab wrap around inside the sheet; the page behind is inert.
    const visited = new Set<string | null>();
    for (let presses = 0; presses < 12; presses++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'))).toBe(true);
      visited.add(await activeName(page));
    }
    expect(visited).toContain('Add task');
    expect(visited).toContain('new-task-title');
    await newTaskField(page).focus();
    await page.keyboard.press('Shift+Tab');
    await expect(sheetButton(page, 'Add task')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(newTaskField(page)).toBeFocused();

    // Escape closes it, focus returns to +, and the typed draft is kept.
    await page.keyboard.type('Sheet: kept draft');
    await page.keyboard.press('Escape');
    await expect(addSheet(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(newTaskField(page)).toHaveValue('Sheet: kept draft');
    // Cancel too.
    await sheetButton(page, 'Cancel').click();
    await expect(addSheet(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    // And a click on the backdrop, outside the sheet.
    await addButton(page).click();
    await page.mouse.click(20, 20);
    await expect(addSheet(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    expect(bodies).toEqual([]);

    // An empty title is refused inside the sheet, which stays open.
    await addButton(page).click();
    await newTaskField(page).fill('   ');
    await sheetButton(page, 'Add task').click();
    await expect(addSheet(page).getByRole('alert')).toHaveText('Enter a task title.');
    await expect(newTaskField(page)).toHaveAttribute('aria-invalid', 'true');
    await newTaskField(page).fill('Sheet: kept draft');
    await sheetButton(page, 'Add task').click();
    await expect(checkbox(page, 'Sheet: kept draft')).toBeVisible();
    await expect(addSheet(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    expect(bodies).toEqual([{ title: 'Sheet: kept draft' }]);
  });

  test('adds a task with each chip and sends exactly the chosen fields; a task for another list says where it went (AC-5, AC-6)', async ({
    page,
  }, testInfo) => {
    await signIn(page, 'Household One');
    await createList(page, 'Chips: Garden');
    await pick(page, 'Inbox');
    const bodies = recordCreates(page);

    await addButton(page).click();
    await expect(chip(page, 'Due date')).toHaveAccessibleName('Due date: none');
    await expect(chip(page, 'Repeat')).toHaveCount(0);
    await expect(chip(page, 'List')).toHaveAccessibleName('List: Inbox');
    await expect(chip(page, 'Notes')).toHaveAccessibleName('Notes: none');
    await newTaskField(page).fill('Chips: water the roses');

    // Date: Today, Tomorrow and Next week, and the date field.
    await chip(page, 'Due date').click();
    await expect(chip(page, 'Due date')).toHaveAttribute('aria-expanded', 'true');
    const date = addSheet(page).getByLabel('Due date', { exact: true });
    await sheetButton(page, 'Today').click();
    await expect(chip(page, 'Due date')).toHaveAccessibleName('Due date: Today');
    await expect(date).toHaveValue('2026-11-20');
    await sheetButton(page, 'Next week').click();
    await expect(date).toHaveValue('2026-11-27');
    await expect(chip(page, 'Due date')).toHaveAccessibleName(/^Due date: Fri, Nov 27$/);
    await sheetButton(page, 'Tomorrow').click();
    await expect(chip(page, 'Due date')).toHaveAccessibleName('Due date: Tomorrow');
    await expect(sheetButton(page, 'Tomorrow')).toHaveAttribute('aria-pressed', 'true');
    await screenshot(page, testInfo, 'sheet-date-chip');

    // Repeat, now that there is a date.
    await chip(page, 'Repeat').click();
    await addSheet(page).getByRole('combobox', { name: 'Repeats', exact: true }).selectOption({ label: 'Weekly' });
    await expect(chip(page, 'Repeat')).toHaveAccessibleName('Repeat: Weekly');
    await expect(sheetButton(page, 'Clear repeat')).toBeVisible();

    // List: Inbox and every list.
    await chip(page, 'List').click();
    const listOptions = addSheet(page).getByRole('group', { name: 'List' }).getByRole('button');
    await expect(listOptions).toHaveText(['Inbox', 'Chips: Garden']);
    await sheetButton(page, 'Chips: Garden').click();
    await expect(chip(page, 'List')).toHaveAccessibleName('List: Chips: Garden');

    // Notes, typed and then closed again: still sent.
    await chip(page, 'Notes').click();
    await addSheet(page).getByRole('textbox', { name: 'Notes', exact: true }).fill('Before the frost');
    await chip(page, 'Notes').click();
    await expect(chip(page, 'Notes')).toHaveAccessibleName('Notes: added');
    await screenshot(page, testInfo, 'sheet-all-chips');
    await sheetButton(page, 'Add task').click();

    // It went to another list than the one shown: a notice says where.
    await expect(statusMessage(page)).toHaveText('Added "Chips: water the roses" to Chips: Garden.');
    await expect(addSheet(page)).toHaveCount(0);
    await expect(addButton(page)).toBeFocused();
    await expect(checkbox(page, 'Chips: water the roses')).toHaveCount(0);
    expect(bodies).toEqual([
      {
        title: 'Chips: water the roses',
        notes: 'Before the frost',
        dueDate: '2026-11-21',
        repeat: { every: 1, unit: 'week' },
        listId: expect.any(Number),
      },
    ]);
    await pick(page, 'Chips: Garden');
    await expect(checkbox(page, 'Chips: water the roses')).toBeVisible();

    // A plain add in the list's view sends only the title and the list; the
    // List chip starts at the list shown. Clearing the date clears its repeat.
    await addButton(page).click();
    await expect(chip(page, 'List')).toHaveAccessibleName('List: Chips: Garden');
    await expect(chip(page, 'Due date')).toHaveAccessibleName('Due date: none');
    await newTaskField(page).fill('Chips: buy seeds');
    await chip(page, 'Due date').click();
    await sheetButton(page, 'Today').click();
    await chip(page, 'Repeat').click();
    await addSheet(page).getByRole('combobox', { name: 'Repeats', exact: true }).selectOption({ label: 'Daily' });
    await sheetButton(page, 'Clear due date').click();
    await expect(chip(page, 'Repeat')).toHaveCount(0);
    await newTaskField(page).press('Enter');
    await expect(checkbox(page, 'Chips: buy seeds')).toBeVisible();
    expect(bodies[1]).toEqual({ title: 'Chips: buy seeds', listId: expect.any(Number) });

    // A date out of range is refused on its field, with the Date chip opened.
    await addButton(page).click();
    await newTaskField(page).fill('Chips: too late');
    await chip(page, 'Due date').click();
    await date.fill('2101-01-01');
    await chip(page, 'Due date').click();
    await expect(chip(page, 'Due date')).toHaveAttribute('aria-expanded', 'false');
    await newTaskField(page).press('Enter');
    await expect(chip(page, 'Due date')).toHaveAttribute('aria-expanded', 'true');
    await expect(addSheet(page).getByRole('alert')).toHaveText('Choose a due date from January 1, 2025 to December 31, 2100.');
    await expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toHaveLength(2);
  });
});

test('the completed tasks sit behind "Show N done", collapsed on every load (AC-7)', async ({ page }) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Done: one');
  await addTask(page, 'Done: two');
  await addTask(page, 'Done: open');
  await checkbox(page, 'Done: one').click();
  await expect(statusMessage(page)).toHaveText('"Done: one" was moved to Completed.');
  await checkbox(page, 'Done: two').click();
  await expect(statusMessage(page)).toHaveText('"Done: two" was moved to Completed.');
  const toggle = page.getByRole('button', { name: 'Show 2 done' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('list', { name: 'Completed' })).toBeHidden();
  await toggle.click();
  const hide = page.getByRole('button', { name: 'Hide done' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('list', { name: 'Completed' }).getByRole('checkbox')).toHaveCount(2);
  await hide.click();
  await expect(page.getByRole('button', { name: 'Show 2 done' })).toHaveAttribute('aria-expanded', 'false');
  // Opened again, then reloaded: collapsed again.
  await page.getByRole('button', { name: 'Show 2 done' }).click();
  await expect(page.getByRole('button', { name: 'Hide done' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Show 2 done' })).toHaveAttribute('aria-expanded', 'false');
});

for (const [name, viewport] of [
  ['wide', { width: 1280, height: 860 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`one column on a ${name} screen; the + button never covers the last task, and reduced motion stops the sheet animation (AC-1, AC-10)`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await signIn(page, 'Household One');
    // Enough tasks to scroll.
    for (let index = 1; index <= 12; index++) await addTask(page, `Column: task ${String(index).padStart(2, '0')}`);
    // No rail, no add form: the title, the account, the sheet and the + button.
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'New task' })).toHaveCount(0);
    await expect(viewTitle(page)).toHaveText('All tasks');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

    // Scrolled to the end, the last row clears the + button.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const lastRow = page.getByRole('listitem').filter({ has: checkbox(page, 'Column: task 01') });
    const row = await lastRow.boundingBox();
    const plus = await addButton(page).boundingBox();
    expect(row && plus).toBeTruthy();
    expect(row!.y + row!.height).toBeLessThanOrEqual(plus!.y);
    await screenshot(page, testInfo, `column-${name}-bottom`);

    // Reduced motion: the sheet appears without its rise animation.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addButton(page).click();
    expect(await addSheet(page).evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    await page.keyboard.press('Escape');
    await viewTitle(page).click();
    expect(await viewMenu(page).evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await addButton(page).click();
    expect(await addSheet(page).evaluate((element) => getComputedStyle(element).animationName)).not.toBe('none');
    await page.keyboard.press('Escape');
  });
}

// Where focus goes when the control it was on leaves the page in a
// background refresh: Two changes One's shared list, and One's page applies
// it on its next 30-second refresh.
test('a refresh that takes away the control with focus moves it to the + button or the view title, and never out of the open add sheet (AC-8)', async ({
  browser,
}, testInfo) => {
  // Two members and five refreshes take longer than one page.
  test.setTimeout(120_000);
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  try {
    // Two's shared list, with one task, shown in One's page.
    await createList(two, 'Focus: shared');
    await addTask(two, 'Focus: only task');
    await share(two, 'Focus: shared');
    await nextRefresh(one);
    await pick(one, 'Focus: shared (shared)');
    await expect(checkbox(one, 'Focus: only task')).toBeVisible();

    // 1. Focus on the only row, which Two deletes: no row is left, so focus
    // goes to the + button (it went to the new-task field before).
    await checkbox(one, 'Focus: only task').focus();
    await button(two, 'Delete "Focus: only task"').click();
    await button(two, 'Confirm deleting "Focus: only task"').click();
    await expect(checkbox(two, 'Focus: only task')).toHaveCount(0);
    await nextRefresh(one);
    await expect(checkbox(one, 'Focus: only task')).toHaveCount(0);
    await expect(addButton(one)).toBeFocused();

    // 2. The same with the add sheet open: focus stays in it, the sheet stays
    // open with its draft, and the row is gone behind it.
    await addTask(two, 'Focus: second task');
    await nextRefresh(one);
    await expect(checkbox(one, 'Focus: second task')).toBeVisible();
    await addButton(one).click();
    await newTaskField(one).fill('Focus: half typed');
    await button(two, 'Delete "Focus: second task"').click();
    await button(two, 'Confirm deleting "Focus: second task"').click();
    await nextRefresh(one);
    await expect(checkbox(one, 'Focus: second task')).toHaveCount(0);
    await expect(newTaskField(one)).toBeFocused();
    await expect(newTaskField(one)).toHaveValue('Focus: half typed');
    await one.keyboard.press('Escape');

    // 3. Focus on a List option in the open sheet, whose list Two stops
    // sharing: focus moves to the List chip, inside the sheet, which stays
    // open; the view behind falls back to Inbox.
    await addButton(one).click();
    await chip(one, 'List').click();
    await sheetButton(one, 'Focus: shared (shared)').focus();
    await pick(two, 'Manage lists');
    await button(two, 'Stop sharing "Focus: shared"').click();
    await expect(viewItem(two, 'Focus: shared')).toBeAttached();
    await nextRefresh(one);
    await expect(sheetButton(one, 'Focus: shared (shared)')).toHaveCount(0);
    await expect(chip(one, 'List')).toBeFocused();
    await expect(chip(one, 'List')).toHaveAccessibleName('List: Inbox');
    await expect(addSheet(one)).toBeVisible();
    await expect(viewTitle(one)).toHaveText('Inbox');
    // The page's notice sits behind the sheet, in inert content; the sheet's
    // own live region says it (tasks-calm-layout R1-F3).
    const fellBack = '"Focus: shared" was deleted or is no longer shared with you, so Inbox is shown.';
    const sheetSays = addSheet(one).locator('[aria-live="polite"]');
    await expect(sheetSays).toHaveText(fellBack);
    expect(await sheetSays.evaluate((region) => region.closest('[inert]') === null)).toBe(true);
    expect(await statusMessage(one).evaluate((region) => region.closest('[inert]') !== null)).toBe(true);
    await one.keyboard.press('Escape');
    await expect(addButton(one)).toBeFocused();

    // 4. Focus on the list's item in the open view picker, which goes when
    // Two stops sharing it again: focus goes to the view title (it went to
    // the selected tab before).
    await button(two, 'Share "Focus: shared" with household').click();
    await expect(viewItem(two, 'Focus: shared (shared)')).toBeAttached();
    await nextRefresh(one);
    await pick(one, 'Focus: shared (shared)');
    await viewTitle(one).click();
    await expect(viewItem(one, 'Focus: shared (shared)')).toBeFocused();
    await button(two, 'Stop sharing "Focus: shared"').click();
    await expect(viewItem(two, 'Focus: shared')).toBeAttached();
    await nextRefresh(one);
    await expect(viewItem(one, 'Focus: shared (shared)')).toHaveCount(0);
    await expect(viewTitle(one)).toBeFocused();
    await expect(viewTitle(one)).toHaveText('Inbox');
    await expect(statusMessage(one)).toHaveText(
      '"Focus: shared" was deleted or is no longer shared with you, so Inbox is shown.',
    );
    // The menu closed with it, and the arrows open it again on the checked
    // item (tasks-calm-layout R1-F2).
    await expect(viewMenu(one)).toBeHidden();
    await expect(viewTitle(one)).toHaveAttribute('aria-expanded', 'false');
    await one.keyboard.press('ArrowDown');
    await expect(viewItem(one, 'Inbox')).toBeFocused();
    await one.keyboard.press('ArrowDown');
    await expect(viewItem(one, 'Assigned to me')).toBeFocused();
    await one.keyboard.press('Escape');
    await expect(viewMenu(one)).toBeHidden();
    await expect(viewTitle(one)).toBeFocused();

    // 5. Focus on the only entry in One's Manage lists, which Two deletes:
    // Manage lists goes with it, and focus goes to the view title (it went to
    // New list before).
    await button(two, 'Share "Focus: shared" with household').click();
    await expect(viewItem(two, 'Focus: shared (shared)')).toBeAttached();
    await nextRefresh(one);
    await expect(viewItem(one, 'Focus: shared (shared)')).toBeAttached();
    await pick(one, 'Manage lists');
    await button(one, 'Rename "Focus: shared"').focus();
    await button(two, 'Delete list "Focus: shared"').click();
    await button(two, 'Confirm deleting list "Focus: shared"').click();
    await expect(viewItem(two, 'Focus: shared (shared)')).toHaveCount(0);
    await nextRefresh(one);
    await expect(one.getByRole('region', { name: 'Manage lists' })).toHaveCount(0);
    await expect(viewTitle(one)).toBeFocused();
    await screenshot(one, testInfo, 'focus-after-refresh');
  } finally {
    await one.context().close();
    await two.context().close();
  }
});

test('two lists with the same name, the user\'s and another member\'s, are both offered and each takes its own tasks (tasks-calm-layout R1-F1)', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const one = await member(browser, 'Household One');
  const two = await member(browser, 'Household Two');
  const errors: string[] = [];
  one.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  try {
    // Names are unique per owner only: both members share a "Dup: Home"
    // (made through the API, so neither page sees the other's too early).
    const sharedList = (page: Page) =>
      page.evaluate(async () => {
        const headers = { 'Content-Type': 'application/json' };
        const created = await fetch('/api/lists', { method: 'POST', headers, body: JSON.stringify({ name: 'Dup: Home' }) });
        const { list } = (await created.json()) as { list: { id: number } };
        const shared = await fetch(`/api/lists/${list.id}`, { method: 'PATCH', headers, body: JSON.stringify({ shared: true }) });
        if (!created.ok || !shared.ok) throw new Error('could not make the list');
        return list.id;
      });
    const mineId = await sharedList(one);
    const theirsId = await sharedList(two);
    await nextRefresh(one);
    await expect(viewMenu(one).getByRole('menuitemradio', { name: 'Dup: Home (shared)', includeHidden: true })).toHaveCount(2);
    await pick(one, 'All tasks');

    const creates = recordCreates(one);
    const options = addSheet(one).getByRole('button', { name: 'Dup: Home (shared)', exact: true });
    for (const [index, title] of ['Dup: into mine', 'Dup: into theirs'].entries()) {
      await addButton(one).click();
      await newTaskField(one).fill(title);
      await chip(one, 'List').click();
      await expect(options).toHaveCount(2);
      await options.nth(index).click();
      await expect(options.nth(index)).toHaveAttribute('aria-pressed', 'true');
      await expect(options.nth(1 - index)).toHaveAttribute('aria-pressed', 'false');
      await sheetButton(one, 'Add task').click();
      await expect(addSheet(one)).toHaveCount(0);
      await expect(checkbox(one, title)).toBeVisible();
    }
    expect(creates).toEqual([
      { title: 'Dup: into mine', listId: mineId },
      { title: 'Dup: into theirs', listId: theirsId },
    ]);

    // Each list's view shows its own task.
    const items = viewMenu(one).getByRole('menuitemradio', { name: 'Dup: Home (shared)', includeHidden: true });
    await viewTitle(one).click();
    await items.nth(0).click();
    await expect(checkbox(one, 'Dup: into mine')).toBeVisible();
    await expect(checkbox(one, 'Dup: into theirs')).toHaveCount(0);
    await viewTitle(one).click();
    await items.nth(1).click();
    await expect(checkbox(one, 'Dup: into theirs')).toBeVisible();
    await expect(checkbox(one, 'Dup: into mine')).toHaveCount(0);
    expect(errors.filter((text) => /same key/.test(text))).toEqual([]);
  } finally {
    await one.context().close();
    await two.context().close();
  }
});
