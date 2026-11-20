import { type APIRequestContext, expect, type Page, type Request, test, type TestInfo } from '@playwright/test';

// End-to-end checks in a real browser against the Vite dev server and the real
// API on a disposable database. Sign-in goes through the fixture SSO provider
// (packages/api/test/fixture.ts); no real credentials or hosted SSO are used.
//
// All tests share one database for the run, and "Household One" keeps the
// tasks earlier tests left behind. Each test therefore uses its own titles and
// only looks at those rows.

type FixtureUser = 'Household One' | 'Household Two';

// The API checks the "today" a completing browser sends against its own date,
// so a test that fixes the browser clock sets the API clock to the same moment
// (packages/api/test/e2e-server.ts). Both keep running from there. Every test
// starts with the real clock on both sides.
const apiOrigin = `http://localhost:${process.env.E2E_API_PORT ?? 3173}`;
async function setServerClock(request: APIRequestContext, time: Date | null) {
  const response = await request.put(`${apiOrigin}/e2e/clock`, { data: { time: time?.toISOString() ?? null } });
  expect(response.ok()).toBe(true);
}
async function fixClock(page: Page, request: APIRequestContext, time: Date) {
  await page.clock.install({ time });
  await setServerClock(request, time);
}
test.beforeEach(async ({ request }) => {
  await setServerClock(request, null);
});

async function signIn(page: Page, user: FixtureUser) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with Pior Labs' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture central SSO' })).toBeVisible();
  await page.getByRole('link', { name: user }).click();
  await expect(page.getByText(`Signed in as ${user}`)).toBeVisible();
  await expect(page.getByLabel('New task')).toBeVisible();
}

// The visible group lists (Overdue, Today, Upcoming, No date, and Completed
// when it is expanded). Matching them all keeps rows in page order.
const taskList = (page: Page) => page.getByRole('list');
const completedToggle = (page: Page) => page.getByRole('button', { name: /^Completed \(\d+\)$/ });

// The Completed section starts collapsed on every page load.
async function expandCompleted(page: Page) {
  await expect(completedToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await completedToggle(page).click();
  await expect(completedToggle(page)).toHaveAttribute('aria-expanded', 'true');
}
const checkbox = (page: Page, title: string) =>
  page.getByRole('checkbox', { name: title, exact: true });
const editButton = (page: Page, title: string) =>
  page.getByRole('button', { name: `Edit "${title}"`, exact: true });
const deleteButton = (page: Page, title: string) =>
  page.getByRole('button', { name: `Delete "${title}"`, exact: true });
const editField = (page: Page, title: string) =>
  page.getByRole('textbox', { name: `New title for "${title}"`, exact: true });

async function addTask(page: Page, title: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
  await expect(checkbox(page, title)).toBeVisible();
}

// Asserts the order of the given titles in the list, top to bottom, ignoring
// other rows. It retries, so it also waits for the list after a reload.
async function expectOrder(page: Page, expected: string[]) {
  await expect
    .poll(async () => {
      const all = await taskList(page).locator('label').allTextContents();
      return all.filter((title) => expected.includes(title));
    })
    .toEqual(expected);
}

// The checkbox changes only after the server stored the new state, so this
// clicks and then waits, instead of expecting an immediate change. A task
// completed while the Completed section is collapsed leaves view, so this
// expands the section to show it again.
async function complete(page: Page, title: string) {
  await checkbox(page, title).click();
  if ((await completedToggle(page).getAttribute('aria-expanded')) === 'false') {
    await expect(page.getByRole('status')).toHaveText(`"${title}" was moved to Completed.`);
    await expandCompleted(page);
  }
  await expect(checkbox(page, title)).toBeChecked();
}

// Presses Tab until the target has focus. Chromium stops on each part of a
// date field (month, day, year), so the number of presses depends on the field.
async function tabTo(page: Page, target: ReturnType<Page['getByRole']>) {
  for (let presses = 0; presses < 8; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

// Records the task writes the page sends, to prove that an action sent none.
function recordWrites(page: Page) {
  const writes: string[] = [];
  page.on('request', (request: Request) => {
    const { pathname } = new URL(request.url());
    if (request.method() !== 'GET' && pathname.startsWith('/api/tasks')) {
      writes.push(`${request.method()} ${pathname.replace(/\d+$/, ':id')}`);
    }
  });
  return writes;
}

test('signs in, creates tasks and completes one; all of it survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Pior Labs' })).toBeVisible();
  await expect(page.getByLabel('New task')).toHaveCount(0);

  await signIn(page, 'Household One');
  await addTask(page, 'Start: buy oat milk');
  await addTask(page, 'Start: water the plants');
  await expect(page.getByLabel('New task')).toBeFocused();
  await expect(page.getByLabel('New task')).toHaveValue('');

  // Completing moves the task into the collapsed Completed section.
  await checkbox(page, 'Start: buy oat milk').click();
  await expect(checkbox(page, 'Start: buy oat milk')).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('"Start: buy oat milk" was moved to Completed.');
  await expandCompleted(page);
  await expect(checkbox(page, 'Start: buy oat milk')).toBeChecked();
  await expectOrder(page, ['Start: water the plants', 'Start: buy oat milk']);

  await page.reload();
  // The completion state came back from the database: still in Completed,
  // which is collapsed again, below the open task.
  await expect(checkbox(page, 'Start: water the plants')).not.toBeChecked();
  await expect(checkbox(page, 'Start: buy oat milk')).toHaveCount(0);
  await expandCompleted(page);
  await expectOrder(page, ['Start: water the plants', 'Start: buy oat milk']);
  await expect(checkbox(page, 'Start: buy oat milk')).toBeChecked();
});

test('renames a task with the keyboard only', async ({ page }) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Keyboard: older');
  await addTask(page, 'Keyboard: buy oat mlik');
  await addTask(page, 'Keyboard: newer');
  await complete(page, 'Keyboard: buy oat mlik');
  const writes = recordWrites(page);

  // From the row's checkbox, Tab reaches Edit; Enter opens the field with focus in it.
  await checkbox(page, 'Keyboard: buy oat mlik').focus();
  await page.keyboard.press('Tab');
  await expect(editButton(page, 'Keyboard: buy oat mlik')).toBeFocused();
  await page.keyboard.press('Enter');
  const field = editField(page, 'Keyboard: buy oat mlik');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Keyboard: buy oat mlik');

  // The caret is at the end: fix the typo by retyping the last word.
  for (let i = 0; i < 'mlik'.length; i++) await page.keyboard.press('Backspace');
  await page.keyboard.type('milk  ');
  await page.keyboard.press('Enter');

  await expect(checkbox(page, 'Keyboard: buy oat milk')).toBeVisible();
  await expect(checkbox(page, 'Keyboard: buy oat mlik')).toHaveCount(0);
  // Focus returns to the row's Edit control, now named after the new title.
  await expect(editButton(page, 'Keyboard: buy oat milk')).toBeFocused();
  // Renaming changed neither the completion state nor the position in the list
  // (completed, so in the Completed section below the open tasks).
  await expect(checkbox(page, 'Keyboard: buy oat milk')).toBeChecked();
  const order = ['Keyboard: newer', 'Keyboard: older', 'Keyboard: buy oat milk'];
  await expectOrder(page, order);
  expect(writes).toEqual(['PATCH /api/tasks/:id']);

  await page.reload();
  await expandCompleted(page);
  await expectOrder(page, order);
  await expect(checkbox(page, 'Keyboard: buy oat milk')).toBeChecked();
  await expect(checkbox(page, 'Keyboard: buy oat mlik')).toHaveCount(0);
});

test('renames a task with the pointer, after an invalid title is refused', async ({ page }) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Pointer: call the plumer');
  const writes = recordWrites(page);

  await editButton(page, 'Pointer: call the plumer').click();
  const field = editField(page, 'Pointer: call the plumer');
  await expect(field).toBeFocused();
  // Only the edited row changes: the title is replaced by the field, Save and Cancel.
  await expect(checkbox(page, 'Pointer: call the plumer')).toHaveCount(0);

  await field.fill('   ');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(taskList(page).getByRole('alert')).toHaveText('Enter a task title.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(writes).toEqual([]);

  await field.fill('  Pointer: call the plumber ');
  await expect(taskList(page).getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(checkbox(page, 'Pointer: call the plumber')).toBeVisible();
  await expect(editButton(page, 'Pointer: call the plumber')).toBeFocused();
  await expect(page.getByRole('textbox', { name: /^New title for/ })).toHaveCount(0);
  expect(writes).toEqual(['PATCH /api/tasks/:id']);

  await page.reload();
  await expect(checkbox(page, 'Pointer: call the plumber')).toBeVisible();
  await expect(checkbox(page, 'Pointer: call the plumer')).toHaveCount(0);
});

test('cancels a rename with Escape and with Cancel, sending nothing', async ({ page }) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Cancel: keep this title');
  const writes = recordWrites(page);

  await editButton(page, 'Cancel: keep this title').click();
  await editField(page, 'Cancel: keep this title').fill('Cancel: thrown away');
  await page.keyboard.press('Escape');
  await expect(checkbox(page, 'Cancel: keep this title')).toBeVisible();
  await expect(editButton(page, 'Cancel: keep this title')).toBeFocused();

  await editButton(page, 'Cancel: keep this title').click();
  // The field starts from the stored title again.
  await expect(editField(page, 'Cancel: keep this title')).toHaveValue('Cancel: keep this title');
  await editField(page, 'Cancel: keep this title').fill('Cancel: also thrown away');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(checkbox(page, 'Cancel: keep this title')).toBeVisible();
  await expect(editButton(page, 'Cancel: keep this title')).toBeFocused();

  // Escape also cancels from the form's buttons, not only from the field.
  await page.keyboard.press('Enter');
  await editField(page, 'Cancel: keep this title').fill('Cancel: thrown away from a button');
  // Past the due date field to Save.
  await tabTo(page, page.getByRole('button', { name: 'Save', exact: true }));
  await page.keyboard.press('Escape');
  await expect(checkbox(page, 'Cancel: keep this title')).toBeVisible();
  await expect(editButton(page, 'Cancel: keep this title')).toBeFocused();

  // An unchanged title is not sent either.
  await editButton(page, 'Cancel: keep this title').click();
  await page.keyboard.press('Enter');
  await expect(editButton(page, 'Cancel: keep this title')).toBeFocused();
  expect(writes).toEqual([]);

  await page.reload();
  await expect(checkbox(page, 'Cancel: keep this title')).toBeVisible();
  await expect(page.getByText('thrown away')).toHaveCount(0);
});

test('deletes a task after confirmation; cancelling keeps it', async ({ page }) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Delete: below');
  await addTask(page, 'Delete: this one');
  await addTask(page, 'Delete: above');
  const writes = recordWrites(page);
  let dialogs = 0;
  page.on('dialog', (dialog) => {
    dialogs++;
    void dialog.dismiss();
  });

  // Step one only asks. Focus lands on Cancel.
  await deleteButton(page, 'Delete: this one').click();
  const question = page.getByRole('group', { name: 'Delete "Delete: this one"?' });
  await expect(question.getByText('Delete this task?')).toBeVisible();
  const cancel = page.getByRole('button', { name: 'Cancel deleting "Delete: this one"' });
  const confirm = page.getByRole('button', { name: 'Confirm deleting "Delete: this one"' });
  await expect(cancel).toBeFocused();
  await expect(page.getByText('Delete this task?')).toHaveCount(1);

  await cancel.click();
  await expect(page.getByText('Delete this task?')).toHaveCount(0);
  await expect(deleteButton(page, 'Delete: this one')).toBeFocused();
  expect(writes).toEqual([]);
  await page.reload();
  await expectOrder(page, ['Delete: above', 'Delete: this one', 'Delete: below']);

  // Keyboard: Enter on Delete asks, Enter again only cancels, Shift+Tab reaches Confirm.
  await deleteButton(page, 'Delete: this one').focus();
  await page.keyboard.press('Enter');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(deleteButton(page, 'Delete: this one')).toBeFocused();
  await expect(checkbox(page, 'Delete: this one')).toBeVisible();
  // Escape closes the question too, also from Confirm.
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Delete this task?')).toHaveCount(0);
  await expect(deleteButton(page, 'Delete: this one')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(checkbox(page, 'Delete: this one')).toHaveCount(0);
  // Focus moves to the first control of the row that followed the deleted one.
  await expect(checkbox(page, 'Delete: below')).toBeFocused();
  await expectOrder(page, ['Delete: above', 'Delete: below']);
  expect(writes).toEqual(['DELETE /api/tasks/:id']);
  expect(dialogs).toBe(0);

  await page.reload();
  await expectOrder(page, ['Delete: above', 'Delete: below']);
  await expect(checkbox(page, 'Delete: this one')).toHaveCount(0);
});

test('a second user sees none of the first user\'s tasks, and deleting the last task shows the empty state', async ({
  page,
  browser,
}) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Private: household one only');

  // This is the only test that signs in as Household Two, so it starts empty.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, 'Household Two');
  await expect(other.getByText('No tasks yet. Add your first one above.')).toBeVisible();
  await expect(other.getByRole('list')).toHaveCount(0);
  await expect(completedToggle(other)).toHaveCount(0);
  await expect(other.getByText('Private: household one only')).toHaveCount(0);

  await addTask(other, 'Private: household two only');
  expect(await taskList(other).locator('label').allTextContents()).toEqual([
    'Private: household two only',
  ]);
  await page.reload();
  await expect(checkbox(page, 'Private: household one only')).toBeVisible();
  await expect(page.getByText('Private: household two only')).toHaveCount(0);

  // Household Two renames and then deletes its only task.
  await editButton(other, 'Private: household two only').click();
  await editField(other, 'Private: household two only').fill('Private: renamed by two');
  await other.keyboard.press('Enter');
  await expect(checkbox(other, 'Private: renamed by two')).toBeVisible();
  await deleteButton(other, 'Private: renamed by two').click();
  await other.getByRole('button', { name: 'Confirm deleting "Private: renamed by two"' }).click();
  await expect(other.getByText('No tasks yet. Add your first one above.')).toBeVisible();
  await expect(other.getByLabel('New task')).toBeFocused();
  await other.reload();
  await expect(other.getByText('No tasks yet. Add your first one above.')).toBeVisible();

  // None of that touched Household One.
  await page.reload();
  await expect(checkbox(page, 'Private: household one only')).toBeVisible();
  await otherContext.close();
});

test('a task removed in another tab disappears with a notice when it is renamed or deleted', async ({
  page,
  context,
}) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Stale: renamed too late');
  await addTask(page, 'Stale: deleted twice');

  // Same session, second tab: delete both tasks there.
  const second = await context.newPage();
  await second.goto('/');
  for (const title of ['Stale: renamed too late', 'Stale: deleted twice']) {
    await deleteButton(second, title).click();
    await second.getByRole('button', { name: `Confirm deleting "${title}"` }).click();
    await expect(checkbox(second, title)).toHaveCount(0);
  }
  await second.close();

  // The first tab still shows them. The server answers 404 and the rows go away.
  await editButton(page, 'Stale: renamed too late').click();
  await editField(page, 'Stale: renamed too late').fill('Stale: new title');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(
    '"Stale: renamed too late" no longer exists, so it was removed from the list.',
  );
  await expect(page.getByText('Stale: new title')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: /^New title for/ })).toHaveCount(0);

  await deleteButton(page, 'Stale: deleted twice').click();
  await page.getByRole('button', { name: 'Confirm deleting "Stale: deleted twice"' }).click();
  await expect(page.getByRole('status')).toHaveText(
    '"Stale: deleted twice" no longer exists, so it was removed from the list.',
  );
  await expect(checkbox(page, 'Stale: deleted twice')).toHaveCount(0);
});

test('an ended session returns to the signed-out view on rename and on delete', async ({
  page,
  context,
}) => {
  await signIn(page, 'Household One');
  await addTask(page, 'Session: still here');

  for (const act of ['rename', 'delete'] as const) {
    await context.clearCookies();
    if (act === 'rename') {
      await editButton(page, 'Session: still here').click();
      await editField(page, 'Session: still here').fill('Session: never stored');
      await page.keyboard.press('Enter');
    } else {
      await deleteButton(page, 'Session: still here').click();
      await page.getByRole('button', { name: 'Confirm deleting "Session: still here"' }).click();
    }
    await expect(page.getByRole('alert')).toHaveText('Your session has ended. Please sign in again.');
    await expect(page.getByRole('button', { name: 'Sign in with Pior Labs' })).toBeVisible();
    await expect(page.getByLabel('New task')).toHaveCount(0);

    // Signing in again shows the task untouched.
    await signIn(page, 'Household One');
    await expect(checkbox(page, 'Session: still here')).toBeVisible();
    await expect(page.getByText('Session: never stored')).toHaveCount(0);
  }
});

// Due dates. "Today" is the browser's local date, so each scenario fixes the
// browser clock (page.clock, before the first page load) and the timezone. The
// clock keeps running from the fixed time. Dates are written in the locale used
// for the labels below.

const groupList = (page: Page, name: string) => page.getByRole('list', { name, exact: true });
const rowOf = (page: Page, title: string) => page.getByRole('listitem').filter({ has: checkbox(page, title) });
const dueDateField = (page: Page, title: string) => page.getByLabel(`Due date for "${title}"`, { exact: true });

async function addTaskDue(page: Page, title: string, dueDate: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('Due date', { exact: true }).fill(dueDate);
  await page.getByLabel('New task').press('Enter');
  await expect(checkbox(page, title)).toBeVisible();
}

// Records the JSON bodies of task updates, to prove only changed fields are sent.
function recordPatchBodies(page: Page) {
  const bodies: unknown[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname.startsWith('/api/tasks/')) {
      bodies.push(request.postDataJSON());
    }
  });
  return bodies;
}

test.describe('due dates west of UTC', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test.beforeEach(async ({ page, request }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC).
    await fixClock(page, request, new Date('2026-11-20T12:00:00-05:00'));
  });

  test('creates tasks with and without due dates into their groups, with overdue said in words', async ({
    page,
  }, testInfo) => {
    await signIn(page, 'Household One');
    const writes: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/tasks') {
        writes.push(request.postData() ?? '');
      }
    });
    await addTaskDue(page, 'Groups: pay the electricity bill', '2026-11-19');
    await addTaskDue(page, 'Groups: put the bins out', '2026-11-20');
    await addTaskDue(page, 'Groups: dentist appointment', '2026-11-24');
    await addTaskDue(page, 'Groups: renew passport', '2027-02-03');
    await addTask(page, 'Groups: someday, no date');
    // Both fields are cleared after adding, and focus is back in the title field.
    await expect(page.getByLabel('New task')).toBeFocused();
    await expect(page.getByLabel('Due date', { exact: true })).toHaveValue('');
    expect(writes.map((body) => JSON.parse(body))).toEqual([
      { title: 'Groups: pay the electricity bill', dueDate: '2026-11-19' },
      { title: 'Groups: put the bins out', dueDate: '2026-11-20' },
      { title: 'Groups: dentist appointment', dueDate: '2026-11-24' },
      { title: 'Groups: renew passport', dueDate: '2027-02-03' },
      { title: 'Groups: someday, no date' },
    ]);

    // Headings in order, each a list named after it.
    const headings = page.getByRole('heading', { level: 2 });
    await expect(headings.first()).toHaveText('Overdue');
    const names = (await headings.allTextContents()).map((text) => text.replace('▸', ''));
    expect(names.slice(0, 4)).toEqual(['Overdue', 'Today', 'Upcoming', 'No date']);
    await expect(groupList(page, 'Overdue').getByText('Groups: pay the electricity bill')).toBeVisible();
    await expect(groupList(page, 'Today').getByText('Groups: put the bins out')).toBeVisible();
    await expect(groupList(page, 'Upcoming').getByText('Groups: dentist appointment')).toBeVisible();
    await expect(groupList(page, 'Upcoming').getByText('Groups: renew passport')).toBeVisible();
    await expect(groupList(page, 'No date').getByText('Groups: someday, no date')).toBeVisible();
    // Upcoming is sorted by due date, earliest first.
    await expectOrder(page, ['Groups: dentist appointment', 'Groups: renew passport']);

    // Date labels, and overdue in words as well as colour.
    const overdueRow = rowOf(page, 'Groups: pay the electricity bill');
    await expect(overdueRow.getByText('Overdue', { exact: true })).toBeVisible();
    await expect(overdueRow.getByText('Due yesterday')).toBeVisible();
    await expect(rowOf(page, 'Groups: put the bins out').getByText('Due today')).toBeVisible();
    await expect(rowOf(page, 'Groups: dentist appointment').getByText('Due Tue, Nov 24')).toBeVisible();
    await expect(rowOf(page, 'Groups: renew passport').getByText('Due Wed, Feb 3, 2027')).toBeVisible();
    await expect(rowOf(page, 'Groups: put the bins out').getByText('Overdue', { exact: true })).toHaveCount(0);
    await expect(rowOf(page, 'Groups: someday, no date').getByText(/^Due /)).toHaveCount(0);
    // The checkbox is named by the title and described by the due date.
    await expect(checkbox(page, 'Groups: pay the electricity bill')).toHaveAccessibleDescription(
      'Overdue \u00B7 Due yesterday',
    );
    const colour = await overdueRow.getByText('Due yesterday').evaluate((element) => getComputedStyle(element).color);
    const plain = await rowOf(page, 'Groups: put the bins out')
      .getByText('Due today')
      .evaluate((element) => getComputedStyle(element).color);
    expect(colour).not.toBe(plain);

    // Completing the overdue task: it leaves view, and once expanded the
    // Completed section shows it without overdue marking.
    await expect(completedToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await checkbox(page, 'Groups: pay the electricity bill').click();
    await expect(page.getByRole('status')).toHaveText(
      '"Groups: pay the electricity bill" was moved to Completed.',
    );
    await expandCompleted(page);
    const completedRow = rowOf(page, 'Groups: pay the electricity bill');
    await expect(completedRow.getByText('Due yesterday')).toBeVisible();
    await expect(completedRow.getByText('Overdue', { exact: true })).toHaveCount(0);

    // Screenshots of every group, narrow and wide, for the run evidence.
    await addTaskDue(page, 'Groups: water the plants before the frost arrives this weekend', '2026-11-17');
    for (const [name, width] of [
      ['groups-narrow', 375],
      ['groups-wide', 1280],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      const noHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(noHorizontalScroll).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }

    // All of it survives a reload; Completed is collapsed again.
    await page.reload();
    await expect(groupList(page, 'Today').getByText('Groups: put the bins out')).toBeVisible();
    await expect(groupList(page, 'Upcoming').getByText('Groups: dentist appointment')).toBeVisible();
    await expect(checkbox(page, 'Groups: pay the electricity bill')).toHaveCount(0);
    await expandCompleted(page);
    await expect(checkbox(page, 'Groups: pay the electricity bill')).toBeChecked();
  });

  test('changes and removes a due date with the keyboard only', async ({ page }) => {
    await signIn(page, 'Household One');
    await addTask(page, 'Keys: book the car service');
    const bodies = recordPatchBodies(page);

    // Edit, Tab to the date field, type the date and save with Enter.
    await editButton(page, 'Keys: book the car service').focus();
    await page.keyboard.press('Enter');
    await expect(editField(page, 'Keys: book the car service')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dueDateField(page, 'Keys: book the car service')).toBeFocused();
    await page.keyboard.type('11202026');
    await expect(dueDateField(page, 'Keys: book the car service')).toHaveValue('2026-11-20');
    await page.keyboard.press('Enter');

    // Stored: the row moved to Today, and focus is on its Edit control there.
    await expect(groupList(page, 'Today').getByText('Keys: book the car service')).toBeVisible();
    await expect(editButton(page, 'Keys: book the car service')).toBeFocused();
    await expect(rowOf(page, 'Keys: book the car service').getByText('Due today')).toBeVisible();
    expect(bodies).toEqual([{ dueDate: '2026-11-20' }]);

    // Change it: back into the field, a new date, Enter.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(dueDateField(page, 'Keys: book the car service')).toHaveValue('2026-11-20');
    await page.keyboard.type('11182026');
    await page.keyboard.press('Enter');
    await expect(groupList(page, 'Overdue').getByText('Keys: book the car service')).toBeVisible();
    await expect(editButton(page, 'Keys: book the car service')).toBeFocused();
    await expect(rowOf(page, 'Keys: book the car service').getByText('Overdue', { exact: true })).toBeVisible();

    // Escape discards a typed change without a request.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await page.keyboard.type('12252026');
    await page.keyboard.press('Escape');
    await expect(editButton(page, 'Keys: book the car service')).toBeFocused();
    await expect(groupList(page, 'Overdue').getByText('Keys: book the car service')).toBeVisible();

    // Remove it: Tab past the date field to Remove due date; focus lands in the
    // now empty date field, and Enter saves.
    await page.keyboard.press('Enter');
    const remove = page.getByRole('button', { name: 'Remove due date for "Keys: book the car service"' });
    await tabTo(page, remove);
    await page.keyboard.press('Enter');
    await expect(remove).toHaveCount(0);
    await expect(dueDateField(page, 'Keys: book the car service')).toBeFocused();
    await expect(dueDateField(page, 'Keys: book the car service')).toHaveValue('');
    await page.keyboard.press('Enter');
    await expect(groupList(page, 'No date').getByText('Keys: book the car service')).toBeVisible();
    await expect(editButton(page, 'Keys: book the car service')).toBeFocused();
    expect(bodies).toEqual([{ dueDate: '2026-11-20' }, { dueDate: '2026-11-18' }, { dueDate: null }]);

    await page.reload();
    await expect(groupList(page, 'No date').getByText('Keys: book the car service')).toBeVisible();
    await expect(rowOf(page, 'Keys: book the car service').getByText(/^Due /)).toHaveCount(0);
  });

  test('changes and removes a due date with the pointer, after an out-of-range date is refused', async ({
    page,
  }) => {
    await signIn(page, 'Household One');
    await addTaskDue(page, 'Pointer: return the library books', '2026-11-27');
    const bodies = recordPatchBodies(page);

    await editButton(page, 'Pointer: return the library books').click();
    await dueDateField(page, 'Pointer: return the library books').fill('2101-01-01');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(rowOf(page, 'Pointer: return the library books').getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveText('Choose a due date from January 1, 2025 to December 31, 2100.');
    await expect(dueDateField(page, 'Pointer: return the library books')).toHaveAttribute('aria-invalid', 'true');
    expect(bodies).toEqual([]);

    // A new title and date are sent together.
    await editField(page, 'Pointer: return the library books').fill('Pointer: return the books');
    await dueDateField(page, 'Pointer: return the library books').fill('2026-11-21');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(groupList(page, 'Upcoming').getByText('Pointer: return the books')).toBeVisible();
    await expect(rowOf(page, 'Pointer: return the books').getByText('Due tomorrow')).toBeVisible();
    expect(bodies).toEqual([{ title: 'Pointer: return the books', dueDate: '2026-11-21' }]);

    // Remove due date, Save: back to No date. Cancel would have kept it.
    await editButton(page, 'Pointer: return the books').click();
    await page.getByRole('button', { name: 'Remove due date for "Pointer: return the books"' }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(groupList(page, 'Upcoming').getByText('Pointer: return the books')).toBeVisible();
    await editButton(page, 'Pointer: return the books').click();
    await page.getByRole('button', { name: 'Remove due date for "Pointer: return the books"' }).click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(groupList(page, 'No date').getByText('Pointer: return the books')).toBeVisible();
    await expect(editButton(page, 'Pointer: return the books')).toBeFocused();
    expect(bodies).toEqual([{ title: 'Pointer: return the books', dueDate: '2026-11-21' }, { dueDate: null }]);

    await page.reload();
    await expect(groupList(page, 'No date').getByText('Pointer: return the books')).toBeVisible();
  });

  test('completing a task while Completed is collapsed moves focus to the next row', async ({ page }) => {
    await signIn(page, 'Household One');
    await addTaskDue(page, 'Focus: second', '2026-11-12');
    await addTaskDue(page, 'Focus: first', '2026-11-11');
    // Overdue sorts by date: first, then second.
    await expectOrder(page, ['Focus: first', 'Focus: second']);
    await checkbox(page, 'Focus: first').focus();
    await page.keyboard.press('Space');
    await expect(checkbox(page, 'Focus: first')).toHaveCount(0);
    await expect(page.getByRole('status')).toHaveText('"Focus: first" was moved to Completed.');
    await expect(checkbox(page, 'Focus: second')).toBeFocused();

    // Expanded, completing keeps focus on the moved checkbox; so does clearing.
    await expandCompleted(page);
    await checkbox(page, 'Focus: second').press('Space');
    await expect(checkbox(page, 'Focus: second')).toBeChecked();
    await expect(checkbox(page, 'Focus: second')).toBeFocused();
    await checkbox(page, 'Focus: second').press('Space');
    await expect(checkbox(page, 'Focus: second')).not.toBeChecked();
    await expect(checkbox(page, 'Focus: second')).toBeFocused();
    await expect(groupList(page, 'Overdue').getByText('Focus: second')).toBeVisible();
  });

  test('at local midnight a task due today moves to Overdue without a reload', async ({ page, request }) => {
    // 23:59:30 on Friday in Toronto.
    await fixClock(page, request, new Date('2026-11-20T23:59:30-05:00'));
    await signIn(page, 'Household One');
    await addTaskDue(page, 'Midnight: take out the recycling', '2026-11-20');
    await addTaskDue(page, 'Midnight: call grandma', '2026-11-21');
    await expect(groupList(page, 'Today').getByText('Midnight: take out the recycling')).toBeVisible();
    await expect(rowOf(page, 'Midnight: call grandma').getByText('Due tomorrow')).toBeVisible();
    const loads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/tasks') loads.push(request.url());
    });

    // Pass local midnight with keyboard focus on the task that will move.
    await checkbox(page, 'Midnight: take out the recycling').focus();
    await page.clock.runFor(60_000);
    await expect(groupList(page, 'Overdue').getByText('Midnight: take out the recycling')).toBeVisible();
    // Focus moved with the row.
    await expect(checkbox(page, 'Midnight: take out the recycling')).toBeFocused();
    const moved = rowOf(page, 'Midnight: take out the recycling');
    await expect(moved.getByText('Overdue', { exact: true })).toBeVisible();
    await expect(moved.getByText('Due yesterday')).toBeVisible();
    await expect(groupList(page, 'Today').getByText('Midnight: call grandma')).toBeVisible();
    await expect(rowOf(page, 'Midnight: call grandma').getByText('Due today')).toBeVisible();

    // Editing across the next midnight: the row moves to Overdue while the user
    // types, and no keystroke is lost.
    await editButton(page, 'Midnight: call grandma').click();
    const field = editField(page, 'Midnight: call grandma');
    await page.keyboard.type(' at');
    await page.clock.runFor(24 * 60 * 60 * 1000);
    await expect(groupList(page, 'Overdue').getByRole('textbox', { name: 'New title for "Midnight: call grandma"' })).toBeVisible();
    await expect(field).toBeFocused();
    await page.keyboard.type(' noon');
    await expect(field).toHaveValue('Midnight: call grandma at noon');
    await page.keyboard.press('Escape');
    expect(loads).toEqual([]);
  });
});

test.describe('due dates east of UTC', () => {
  test.use({ timezoneId: 'Pacific/Auckland', locale: 'en-US' });

  test('shows the stored date without shifting it', async ({ page, request }) => {
    // Noon on Friday 2026-11-20 in Auckland is still Thursday in UTC.
    await fixClock(page, request, new Date('2026-11-20T12:00:00+13:00'));
    await signIn(page, 'Household One');
    await addTaskDue(page, 'Auckland: farmers market', '2026-11-20');
    await addTaskDue(page, 'Auckland: ferry to Waiheke', '2026-11-21');
    await expect(groupList(page, 'Today').getByText('Auckland: farmers market')).toBeVisible();
    await expect(rowOf(page, 'Auckland: farmers market').getByText('Due today')).toBeVisible();
    await expect(groupList(page, 'Upcoming').getByText('Auckland: ferry to Waiheke')).toBeVisible();
    await expect(rowOf(page, 'Auckland: ferry to Waiheke').getByText('Due tomorrow')).toBeVisible();

    // The API stores and returns exactly the day that was entered.
    const response = await page.request.get('/api/tasks');
    const { tasks } = (await response.json()) as { tasks: { title: string; dueDate: string | null }[] };
    expect(tasks.find((task) => task.title === 'Auckland: farmers market')?.dueDate).toBe('2026-11-20');
    expect(tasks.find((task) => task.title === 'Auckland: ferry to Waiheke')?.dueDate).toBe('2026-11-21');

    // The edit field shows the same day, and a reload changes nothing.
    await editButton(page, 'Auckland: farmers market').click();
    await expect(dueDateField(page, 'Auckland: farmers market')).toHaveValue('2026-11-20');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(groupList(page, 'Today').getByText('Auckland: farmers market')).toBeVisible();
    await expect(rowOf(page, 'Auckland: farmers market').getByText('Due today')).toBeVisible();
  });
});

// Repeating tasks. As for due dates, each scenario fixes the browser clock and
// timezone, and the API clock to the same moment.

const addRepeats = (page: Page) => page.getByRole('combobox', { name: 'Repeats', exact: true });
const rowRepeats = (page: Page, title: string) =>
  page.getByRole('combobox', { name: `Repeats for "${title}"`, exact: true });
const statusMessage = (page: Page) => page.getByRole('status');

// Records the bodies of task writes (POST and PATCH) in order.
function recordBodies(page: Page) {
  const bodies: { method: string; body: unknown }[] = [];
  page.on('request', (request: Request) => {
    const { pathname } = new URL(request.url());
    if (['POST', 'PATCH'].includes(request.method()) && pathname.startsWith('/api/tasks')) {
      bodies.push({ method: request.method(), body: request.postDataJSON() });
    }
  });
  return bodies;
}

// Adds a task with a due date and a preset repeat, using the pointer.
async function addRepeatingTask(page: Page, title: string, dueDate: string, repeat: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('Due date', { exact: true }).fill(dueDate);
  await addRepeats(page).selectOption({ label: repeat });
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(checkbox(page, title)).toBeVisible();
}

// The open occurrence of a title (its completed copies are in Completed).
const openCheckbox = (page: Page, group: string, title: string) =>
  groupList(page, group).getByRole('checkbox', { name: title, exact: true });
// Earlier tests leave completed tasks behind, so the count in the name varies.
const completedList = (page: Page) => page.getByRole('list', { name: /^Completed \(\d+\)$/ });

test.describe('repeating tasks west of UTC', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test.beforeEach(async ({ page, request }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC).
    await fixClock(page, request, new Date('2026-11-20T12:00:00-05:00'));
  });

  test('a weekly task completed on time, early and late lands in the right group', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    const bodies = recordBodies(page);

    // Without a date the control is disabled and says why.
    await expect(addRepeats(page)).toBeDisabled();
    await expect(page.getByText('Set a due date to repeat')).toBeVisible();
    await expect(addRepeats(page)).toHaveAccessibleDescription('Set a due date to repeat');

    await addRepeatingTask(page, 'Weekly: put the bins out', '2026-11-20', 'Weekly');
    await expect(addRepeats(page)).toHaveValue('none');
    const today = rowOf(page, 'Weekly: put the bins out');
    await expect(today.getByText('Repeats weekly')).toBeVisible();
    await expect(checkbox(page, 'Weekly: put the bins out')).toHaveAccessibleDescription(
      'Due today · Repeats weekly',
    );
    expect(bodies[0]).toEqual({
      method: 'POST',
      body: { title: 'Weekly: put the bins out', dueDate: '2026-11-20', repeat: { every: 1, unit: 'week' } },
    });

    // On time, with Completed collapsed: the next one is due a week later, and
    // focus is on its checkbox.
    await openCheckbox(page, 'Today', 'Weekly: put the bins out').click();
    await expect(statusMessage(page)).toHaveText('"Weekly: put the bins out" is next due Fri, Nov 27.');
    await expect(openCheckbox(page, 'Upcoming', 'Weekly: put the bins out')).toBeFocused();
    await expect(openCheckbox(page, 'Upcoming', 'Weekly: put the bins out')).not.toBeChecked();
    await expect(rowOf(page, 'Weekly: put the bins out').getByText('Due Fri, Nov 27')).toBeVisible();
    await expect(completedToggle(page)).toHaveAttribute('aria-expanded', 'false');
    expect(bodies[1]).toEqual({ method: 'PATCH', body: { completed: true, today: '2026-11-20' } });

    // Early: the occurrence after the current due date, not after today.
    await page.keyboard.press('Space');
    await expect(statusMessage(page)).toHaveText('"Weekly: put the bins out" is next due Fri, Dec 4.');
    await expect(openCheckbox(page, 'Upcoming', 'Weekly: put the bins out')).toBeFocused();
    await expect(rowOf(page, 'Weekly: put the bins out').getByText('Due Fri, Dec 4')).toBeVisible();

    // Late by more than one interval: due Tuesday Nov 3, done on Friday Nov 20.
    // The next one is the coming Tuesday, not one of the missed ones.
    await addRepeatingTask(page, 'Weekly: water the ferns', '2026-11-03', 'Weekly');
    await expect(openCheckbox(page, 'Overdue', 'Weekly: water the ferns')).toBeVisible();
    await openCheckbox(page, 'Overdue', 'Weekly: water the ferns').click();
    await expect(statusMessage(page)).toHaveText('"Weekly: water the ferns" is next due Tue, Nov 24.');
    await expect(openCheckbox(page, 'Upcoming', 'Weekly: water the ferns')).toBeFocused();
    await expect(groupList(page, 'Overdue').getByText('Weekly: water the ferns')).toHaveCount(0);

    // The completed occurrences are in Completed, still labelled.
    await expandCompleted(page);
    const done = completedList(page);
    await expect(done.getByRole('checkbox', { name: 'Weekly: put the bins out' })).toHaveCount(2);
    await expect(done.getByRole('checkbox', { name: 'Weekly: water the ferns' })).toBeChecked();
    await expect(
      done.getByRole('listitem').filter({ hasText: 'Weekly: water the ferns' }).getByText('Repeats weekly'),
    ).toBeVisible();

    // Screenshots of repeating rows, narrow and wide, for the run evidence.
    await addRepeatingTask(page, 'Weekly: a long title that wraps on a narrow phone screen, repeating', '2026-11-22', 'Monthly');
    for (const [name, width] of [
      ['repeating-narrow', 375],
      ['repeating-wide', 1280],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      const noHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(noHorizontalScroll).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }

    // All of it survives a reload.
    await page.reload();
    await expect(openCheckbox(page, 'Upcoming', 'Weekly: put the bins out')).toBeVisible();
    await expect(rowOf(page, 'Weekly: put the bins out').getByText('Repeats weekly')).toBeVisible();
    await expect(rowOf(page, 'Weekly: water the ferns').getByText('Due Tue, Nov 24')).toBeVisible();
    await expandCompleted(page);
    await expect(completedList(page).getByRole('checkbox', { name: 'Weekly: put the bins out' })).toHaveCount(2);
  });

  test('un-ticking a completed occurrence removes the next one', async ({ page }) => {
    await signIn(page, 'Household One');
    await addRepeatingTask(page, 'Undo: feed the cat', '2026-11-20', 'Daily');
    await openCheckbox(page, 'Today', 'Undo: feed the cat').click();
    await expect(statusMessage(page)).toHaveText('"Undo: feed the cat" is next due tomorrow.');
    await expect(openCheckbox(page, 'Upcoming', 'Undo: feed the cat')).toBeFocused();

    // Expanded, un-tick the completed one: the next occurrence goes away and
    // focus follows the un-ticked row back to Today.
    await expandCompleted(page);
    const done = completedList(page).getByRole('checkbox', { name: 'Undo: feed the cat' });
    await done.click();
    await expect(statusMessage(page)).toHaveText('"Undo: feed the cat" is open again, and its next occurrence was removed.');
    await expect(openCheckbox(page, 'Today', 'Undo: feed the cat')).toBeFocused();
    await expect(page.getByRole('checkbox', { name: 'Undo: feed the cat', exact: true })).toHaveCount(1);
    await expect(groupList(page, 'Upcoming').getByText('Undo: feed the cat')).toHaveCount(0);

    // Ticked again with Completed expanded: one new next occurrence, focused.
    await page.keyboard.press('Space');
    await expect(openCheckbox(page, 'Upcoming', 'Undo: feed the cat')).toBeFocused();
    await expect(page.getByRole('checkbox', { name: 'Undo: feed the cat', exact: true })).toHaveCount(2);
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'Undo: feed the cat', exact: true })).toHaveCount(1);
    await expect(openCheckbox(page, 'Upcoming', 'Undo: feed the cat')).toBeVisible();
  });

  test('without a due date the Repeats select is disabled and skipped by Tab, and a date enables it', async ({
    page,
  }, testInfo) => {
    await signIn(page, 'Household One');
    const writes = recordBodies(page);
    const repeats = addRepeats(page);
    await expect(repeats).toBeDisabled();
    await expect(repeats).toHaveValue('none');
    await expect(page.getByText('Set a due date to repeat')).toBeVisible();
    // It looks disabled: dimmed and with the not-allowed cursor.
    expect(
      await repeats.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: Number(style.opacity), cursor: style.cursor };
      }),
    ).toEqual({ opacity: 0.6, cursor: 'not-allowed' });
    // Screenshots of the add form without a date, narrow and wide.
    for (const [name, width] of [
      ['repeat-no-date-narrow', 375],
      ['repeat-no-date-wide', 1280],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.locator('form').filter({ has: repeats }).screenshot({ path });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }

    // Keyboard: Tab goes from the date field to Add task, never stopping on
    // Repeats, and Shift+Tab goes straight back to the date field.
    await page.getByLabel('New task').fill('Disabled: wash the car');
    const visited: string[] = [];
    for (let presses = 0; presses < 8; presses++) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || ''));
      if (await page.getByRole('button', { name: 'Add task' }).evaluate((element) => element === document.activeElement)) break;
    }
    await expect(page.getByRole('button', { name: 'Add task' })).toBeFocused();
    expect(visited).not.toContain('new-task-repeat');
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByLabel('Due date', { exact: true })).toBeFocused();
    // The pointer cannot open it either: a click does not focus or change it.
    await repeats.click({ force: true });
    await page.keyboard.press('ArrowDown');
    await expect(repeats).not.toBeFocused();
    await expect(repeats).toHaveValue('none');

    // A date enables it, and it now takes a choice.
    await page.getByLabel('Due date', { exact: true }).fill('2026-11-21');
    await expect(repeats).toBeEnabled();
    await expect(page.getByText('Set a due date to repeat')).toHaveCount(0);
    await repeats.selectOption({ label: 'Daily' });
    await expect(repeats).toHaveValue('daily');
    // Clearing the date disables it again and resets it.
    await page.getByLabel('Due date', { exact: true }).fill('');
    await expect(repeats).toBeDisabled();
    await expect(repeats).toHaveValue('none');
    await expect(page.getByText('Set a due date to repeat')).toBeVisible();
    expect(writes).toEqual([]);
  });

  test('sets a custom "every 2 weeks" repeat with the keyboard only, then stops it', async ({ page }) => {
    await signIn(page, 'Household One');
    const bodies = recordBodies(page);
    await page.getByLabel('New task').fill('Keys: clean the gutters');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Due date', { exact: true })).toBeFocused();
    await page.keyboard.type('11232026');
    // Tab also steps through the parts of the date field.
    await tabTo(page, addRepeats(page));
    // Typing selects an option of a focused select: "C" for Custom.
    await page.keyboard.type('C');
    await expect(addRepeats(page)).toHaveValue('custom');
    await page.keyboard.press('Tab');
    const every = page.getByRole('spinbutton', { name: 'Every' });
    await expect(every).toBeFocused();
    await expect(every).toHaveValue('1');
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('2');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'Repeat unit' })).toBeFocused();
    await page.keyboard.type('w');
    await expect(page.getByRole('combobox', { name: 'Repeat unit' })).toHaveValue('week');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Add task' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(rowOf(page, 'Keys: clean the gutters').getByText('Repeats every 2 weeks')).toBeVisible();
    expect(bodies[0].body).toEqual({
      title: 'Keys: clean the gutters',
      dueDate: '2026-11-23',
      repeat: { every: 2, unit: 'week' },
    });

    // Done early with the keyboard: two weeks after the due date.
    await checkbox(page, 'Keys: clean the gutters').focus();
    await page.keyboard.press('Space');
    await expect(statusMessage(page)).toHaveText('"Keys: clean the gutters" is next due Mon, Dec 7.');
    await expect(openCheckbox(page, 'Upcoming', 'Keys: clean the gutters')).toBeFocused();

    // Stop repeating it: Edit, Tab to Repeats, type "Does" for Does not repeat,
    // Tab past the notes field to Save.
    await page.keyboard.press('Tab');
    await expect(editButton(page, 'Keys: clean the gutters')).toBeFocused();
    await page.keyboard.press('Enter');
    const repeats = rowRepeats(page, 'Keys: clean the gutters');
    await tabTo(page, repeats);
    await expect(repeats).toHaveValue('custom');
    await page.keyboard.type('Does');
    await expect(repeats).toHaveValue('none');
    await expect(page.getByRole('spinbutton', { name: 'Repeat interval for "Keys: clean the gutters"' })).toHaveCount(0);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('textbox', { name: 'Notes for "Keys: clean the gutters"', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editButton(page, 'Keys: clean the gutters')).toBeFocused();
    await expect(rowOf(page, 'Keys: clean the gutters').getByText(/Repeats/)).toHaveCount(0);
    expect(bodies.at(-1)).toEqual({ method: 'PATCH', body: { repeat: null } });

    // Completing it now creates nothing new; it survives a reload as stopped.
    await page.reload();
    await expect(rowOf(page, 'Keys: clean the gutters').getByText('Due Mon, Dec 7')).toBeVisible();
    await expect(rowOf(page, 'Keys: clean the gutters').getByText(/Repeats/)).toHaveCount(0);
    await checkbox(page, 'Keys: clean the gutters').click();
    await expect(statusMessage(page)).toHaveText('"Keys: clean the gutters" was moved to Completed.');
    await expect(page.getByRole('checkbox', { name: 'Keys: clean the gutters', exact: true })).toHaveCount(0);
  });

  test('the edit row sets a repeat by pointer; removing the date resets it', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    await addTask(page, 'Edit: descale the kettle');
    const bodies = recordPatchBodies(page);
    await editButton(page, 'Edit: descale the kettle').click();
    // No date: disabled, with the hint.
    const repeats = rowRepeats(page, 'Edit: descale the kettle');
    await expect(repeats).toBeDisabled();
    await expect(repeats).toHaveAccessibleDescription('Set a due date to repeat');
    await dueDateField(page, 'Edit: descale the kettle').fill('2026-11-25');
    await expect(repeats).toBeEnabled();
    await expect(repeats).not.toHaveAttribute('aria-disabled');
    await repeats.selectOption({ label: 'Custom' });
    await page.getByRole('spinbutton', { name: 'Repeat interval for "Edit: descale the kettle"' }).fill('3');
    await page.getByRole('combobox', { name: 'Repeat unit for "Edit: descale the kettle"' }).selectOption({ label: 'months' });
    // Screenshots of the edit row with Custom open, narrow and wide.
    for (const [name, width] of [
      ['repeat-edit-narrow', 375],
      ['repeat-edit-wide', 1280],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      ).toBe(true);
      const path = testInfo.outputPath(`${name}.png`);
      await page.getByRole('listitem').filter({ has: repeats }).screenshot({ path });
      await testInfo.attach(name, { path, contentType: 'image/png' });
    }
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(rowOf(page, 'Edit: descale the kettle').getByText('Repeats every 3 months')).toBeVisible();
    expect(bodies).toEqual([{ dueDate: '2026-11-25', repeat: { every: 3, unit: 'month' } }]);

    // Remove due date resets the repeat, and both go in one request.
    await editButton(page, 'Edit: descale the kettle').click();
    await expect(repeats).toHaveValue('custom');
    await page.getByRole('button', { name: 'Remove due date for "Edit: descale the kettle"' }).click();
    await expect(repeats).toHaveValue('none');
    await expect(repeats).toBeDisabled();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(groupList(page, 'No date').getByText('Edit: descale the kettle')).toBeVisible();
    expect(bodies).toEqual([
      { dueDate: '2026-11-25', repeat: { every: 3, unit: 'month' } },
      { dueDate: null, repeat: null },
    ]);
    await page.reload();
    await expect(rowOf(page, 'Edit: descale the kettle').getByText(/Repeats/)).toHaveCount(0);
  });
});

test.describe('repeating tasks across a month end', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test('a monthly task on the 31st, set by pointer, keeps the month end', async ({ page, request }) => {
    // Tuesday 2026-12-01, noon in Toronto: the October 31 task is a month late.
    await fixClock(page, request, new Date('2026-12-01T12:00:00-05:00'));
    await signIn(page, 'Household One');
    await addRepeatingTask(page, 'Month end: pay the rent', '2026-10-31', 'Monthly');
    await expect(rowOf(page, 'Month end: pay the rent').getByText('Repeats monthly')).toBeVisible();
    await expect(openCheckbox(page, 'Overdue', 'Month end: pay the rent')).toBeVisible();

    // November 30 has passed too: the next one is December 31.
    const steps = [
      ['Overdue', 'Thu, Dec 31'],
      ['Upcoming', 'Sun, Jan 31, 2027'],
      ['Upcoming', 'Sun, Feb 28, 2027'],
      ['Upcoming', 'Wed, Mar 31, 2027'],
    ] as const;
    for (const [group, next] of steps) {
      await openCheckbox(page, group, 'Month end: pay the rent').click();
      await expect(statusMessage(page)).toHaveText(`"Month end: pay the rent" is next due ${next}.`);
      await expect(openCheckbox(page, 'Upcoming', 'Month end: pay the rent')).toBeFocused();
      await expect(rowOf(page, 'Month end: pay the rent').getByText(`Due ${next}`)).toBeVisible();
    }
    await page.reload();
    await expect(rowOf(page, 'Month end: pay the rent').getByText('Due Wed, Mar 31, 2027')).toBeVisible();
  });
});

test.describe('repeating tasks east of UTC', () => {
  test.use({ timezoneId: 'Pacific/Auckland', locale: 'en-US' });

  test('just after local midnight the local date is sent and decides the next date', async ({ page, request }) => {
    // 00:10 on Saturday 2026-11-21 in Auckland is still Friday 11:10 in UTC.
    await fixClock(page, request, new Date('2026-11-21T00:10:00+13:00'));
    await signIn(page, 'Household One');
    const bodies = recordPatchBodies(page);
    await addRepeatingTask(page, 'Auckland: walk the dog', '2026-11-14', 'Daily');
    await openCheckbox(page, 'Overdue', 'Auckland: walk the dog').click();
    // The local date, not the UTC one: due today, not yesterday.
    expect(bodies).toEqual([{ completed: true, today: '2026-11-21' }]);
    await expect(statusMessage(page)).toHaveText('"Auckland: walk the dog" is next due today.');
    await expect(openCheckbox(page, 'Today', 'Auckland: walk the dog')).toBeFocused();
    await expect(rowOf(page, 'Auckland: walk the dog').getByText('Due today')).toBeVisible();
    const response = await page.request.get('/api/tasks');
    const { tasks } = (await response.json()) as { tasks: { title: string; dueDate: string; completed: boolean }[] };
    expect(
      tasks.filter((task) => task.title === 'Auckland: walk the dog').map(({ dueDate, completed }) => ({ dueDate, completed })),
    ).toEqual([
      { dueDate: '2026-11-21', completed: false },
      { dueDate: '2026-11-14', completed: true },
    ]);
  });
});

test.describe('repeating tasks, more edges west of UTC', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test.beforeEach(async ({ page, request }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC).
    await fixClock(page, request, new Date('2026-11-20T12:00:00-05:00'));
  });

  test('arrowing from Weekly down to Custom starts Custom at every 1 week', async ({ page }) => {
    await signIn(page, 'Household One');
    await addRepeatingTask(page, 'Arrows: sweep the porch', '2026-11-24', 'Weekly');
    await editButton(page, 'Arrows: sweep the porch').click();
    const repeats = rowRepeats(page, 'Arrows: sweep the porch');
    await repeats.focus();
    // Monthly, Yearly, then Custom: each step is a change.
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowDown');
    await expect(repeats).toHaveValue('custom');
    await expect(page.getByRole('spinbutton', { name: 'Repeat interval for "Arrows: sweep the porch"' })).toHaveValue('1');
    await expect(page.getByRole('combobox', { name: 'Repeat unit for "Arrows: sweep the porch"' })).toHaveValue('week');
    await page.keyboard.press('Escape');
  });

  // R3-F1: Backspace empties the focused part of a date field (month, day,
  // year) and the arrow moves to the next part. Once the first part is empty
  // the field holds a partly typed date; once all are, it holds no date.
  const dateState = (field: ReturnType<Page['getByLabel']>) =>
    field.evaluate((element) => ({
      value: (element as HTMLInputElement).value,
      partial: (element as HTMLInputElement).validity.badInput,
    }));
  async function clearDateParts(
    page: Page,
    field: ReturnType<Page['getByLabel']>,
    repeats: ReturnType<Page['getByRole']>,
  ) {
    await field.focus();
    await page.keyboard.press('Backspace');
    // Partly typed: no date, so the select is disabled, but the choice is kept.
    expect(await dateState(field)).toEqual({ value: '', partial: true });
    await expect(repeats).toBeDisabled();
    await expect(repeats).toHaveValue('weekly');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    // Every part is empty. The browser fires no input or change event for
    // this last step.
    expect(await dateState(field)).toEqual({ value: '', partial: false });
    await expect(repeats).toBeDisabled();
    await expect(repeats).toHaveValue('none');
    await expect(repeats).toHaveAccessibleDescription('Set a due date to repeat');
  }

  test('the add form resets the repeat when the date is cleared one part at a time (R3-F1)', async ({ page }) => {
    await signIn(page, 'Household One');
    const bodies = recordBodies(page);
    const date = page.getByLabel('Due date', { exact: true });
    await page.getByLabel('New task').fill('Parts: water the ferns');
    await date.fill('2026-11-24');
    await addRepeats(page).selectOption({ label: 'Weekly' });
    await clearDateParts(page, date, addRepeats(page));
    // Typing a date again starts from "Does not repeat", and so does the task.
    await date.fill('2026-11-24');
    await expect(addRepeats(page)).toBeEnabled();
    await expect(addRepeats(page)).toHaveValue('none');
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(checkbox(page, 'Parts: water the ferns')).toBeVisible();
    expect(bodies).toEqual([{ method: 'POST', body: { title: 'Parts: water the ferns', dueDate: '2026-11-24' } }]);
  });

  test('the edit row resets the repeat when the date is cleared one part at a time (R3-F1)', async ({ page }) => {
    await signIn(page, 'Household One');
    await addRepeatingTask(page, 'Parts: oil the hinges', '2026-11-24', 'Weekly');
    const bodies = recordPatchBodies(page);
    await editButton(page, 'Parts: oil the hinges').click();
    const repeats = rowRepeats(page, 'Parts: oil the hinges');
    await expect(repeats).toHaveValue('weekly');
    await clearDateParts(page, dueDateField(page, 'Parts: oil the hinges'), repeats);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(groupList(page, 'No date').getByText('Parts: oil the hinges')).toBeVisible();
    expect(bodies).toEqual([{ dueDate: null, repeat: null }]);
  });

  test('rapid repeated ticks complete the task once and create one next occurrence', async ({ page }) => {
    await signIn(page, 'Household One');
    const bodies = recordPatchBodies(page);
    await addRepeatingTask(page, 'Rapid: wipe the counters', '2026-11-20', 'Daily');
    // Five clicks in the same moment, before the server answers the first,
    // with focus on the checkbox as after a real click.
    await openCheckbox(page, 'Today', 'Rapid: wipe the counters').evaluate((element) => {
      (element as HTMLElement).focus();
      for (let click = 0; click < 5; click++) (element as HTMLElement).click();
    });
    await expect(statusMessage(page)).toHaveText('"Rapid: wipe the counters" is next due tomorrow.');
    await expect(openCheckbox(page, 'Upcoming', 'Rapid: wipe the counters')).toBeFocused();
    expect(bodies).toEqual([{ completed: true, today: '2026-11-20' }]);
    const response = await page.request.get('/api/tasks');
    const { tasks } = (await response.json()) as { tasks: { title: string; dueDate: string; completed: boolean }[] };
    expect(
      tasks.filter((task) => task.title === 'Rapid: wipe the counters').map(({ dueDate, completed }) => ({ dueDate, completed })),
    ).toEqual([
      { dueDate: '2026-11-21', completed: false },
      { dueDate: '2026-11-20', completed: true },
    ]);
  });

  test('a page left open across local midnight sends the new date when completing', async ({ page, request }) => {
    // 23:59:30 on Friday in Toronto.
    await fixClock(page, request, new Date('2026-11-20T23:59:30-05:00'));
    await signIn(page, 'Household One');
    const bodies = recordPatchBodies(page);
    await addRepeatingTask(page, 'Overnight: take the vitamins', '2026-11-20', 'Daily');
    await expect(openCheckbox(page, 'Today', 'Overnight: take the vitamins')).toBeVisible();
    // Local midnight passes with the page open: the task is now overdue.
    await page.clock.runFor(60_000);
    await expect(openCheckbox(page, 'Overdue', 'Overnight: take the vitamins')).toBeVisible();
    await openCheckbox(page, 'Overdue', 'Overnight: take the vitamins').click();
    expect(bodies).toEqual([{ completed: true, today: '2026-11-21' }]);
    // The next one is due today (the new day), not yesterday.
    await expect(statusMessage(page)).toHaveText('"Overnight: take the vitamins" is next due today.');
    await expect(openCheckbox(page, 'Today', 'Overnight: take the vitamins')).toBeFocused();
  });
});

// The browser's date may be one day ahead of the server's UTC date (UTC+14)
// or one day behind it (UTC-12); both are accepted and decide the next date.
for (const { zone, label, time, today, next } of [
  { zone: 'Pacific/Kiritimati', label: 'UTC+14', time: '2026-11-21T00:30:00+14:00', today: '2026-11-21', next: 'Due today' },
  { zone: 'Etc/GMT+12', label: 'UTC-12', time: '2026-11-20T23:30:00-12:00', today: '2026-11-20', next: 'Due today' },
]) {
  test.describe(`repeating tasks at ${label}`, () => {
    test.use({ timezoneId: zone, locale: 'en-US' });

    test(`the local date is sent and accepted at ${label}`, async ({ page, request }) => {
      await fixClock(page, request, new Date(time));
      await signIn(page, 'Household One');
      const bodies = recordPatchBodies(page);
      const title = `${label}: water the cactus`;
      await addRepeatingTask(page, title, '2026-11-14', 'Daily');
      await openCheckbox(page, 'Overdue', title).click();
      expect(bodies).toEqual([{ completed: true, today }]);
      await expect(statusMessage(page)).toHaveText(`"${title}" is next due today.`);
      await expect(openCheckbox(page, 'Today', title)).toBeFocused();
      await expect(rowOf(page, title).getByText(next)).toBeVisible();
      const response = await page.request.get('/api/tasks');
      const { tasks } = (await response.json()) as { tasks: { title: string; dueDate: string; completed: boolean }[] };
      expect(tasks.find((task) => task.title === title && !task.completed)?.dueDate).toBe(today);
    });
  });
}

test.describe('notes', () => {
  test.use({ timezoneId: 'America/Toronto', locale: 'en-US' });

  test.beforeEach(async ({ page, request }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC).
    await fixClock(page, request, new Date('2026-11-20T12:00:00-05:00'));
  });

  const notesToggle = (page: Page) => page.getByRole('button', { name: 'Add notes', exact: true });
  const addNotes = (page: Page) => page.getByRole('textbox', { name: 'Notes', exact: true });
  const editNotes = (page: Page, title: string) =>
    page.getByRole('textbox', { name: `Notes for "${title}"`, exact: true });
  const rowNotes = (page: Page, title: string) => rowOf(page, title).locator('[data-notes]');
  async function addTaskWithNotes(page: Page, title: string, notes: string) {
    await page.getByLabel('New task').fill(title);
    if ((await notesToggle(page).getAttribute('aria-expanded')) === 'false') await notesToggle(page).click();
    await addNotes(page).fill(notes);
    await addNotes(page).press('Control+Enter');
    await expect(checkbox(page, title)).toBeVisible();
  }
  async function screenshot(page: Page, testInfo: TestInfo, name: string) {
    const path = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(name, { path, contentType: 'image/png' });
  }

  test('adds a task with multi-line notes through the toggle; they survive a reload', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    const bodies = recordBodies(page);
    await expect(notesToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(addNotes(page)).toHaveCount(0);

    await page.getByLabel('New task').fill('Notes: call the plumber');
    // Tab from Add task reaches the toggle; Enter opens the field and Tab reaches it.
    await page.getByRole('button', { name: 'Add task' }).focus();
    await page.keyboard.press('Tab');
    await expect(notesToggle(page)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(notesToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    await expect(addNotes(page)).toBeFocused();
    // Enter is a new line; Ctrl+Enter adds the task.
    await page.keyboard.type('Kitchen tap drips');
    await page.keyboard.press('Enter');
    await page.keyboard.type('  and the shower head');
    await expect(addNotes(page)).toHaveValue('Kitchen tap drips\n  and the shower head');
    expect(bodies).toEqual([]);
    await screenshot(page, testInfo, 'notes-add-form');
    await page.keyboard.press('Control+Enter');

    await expect(checkbox(page, 'Notes: call the plumber')).toBeVisible();
    expect(bodies).toEqual([
      { method: 'POST', body: { title: 'Notes: call the plumber', notes: 'Kitchen tap drips\n  and the shower head' } },
    ]);
    // The field is cleared and collapsed; focus is back in New task.
    await expect(notesToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(addNotes(page)).toHaveCount(0);
    await expect(page.getByLabel('New task')).toBeFocused();
    const notes = rowNotes(page, 'Notes: call the plumber');
    await expect(notes).toBeVisible();
    // Line breaks and the inner spacing are shown as typed.
    expect(await notes.innerText()).toBe('Kitchen tap drips\n  and the shower head');
    await screenshot(page, testInfo, 'notes-row');

    // A plain add still sends only the title.
    await addTask(page, 'Notes: no notes here');
    expect(bodies[1]).toEqual({ method: 'POST', body: { title: 'Notes: no notes here' } });
    await expect(rowNotes(page, 'Notes: no notes here')).toHaveCount(0);

    await page.reload();
    await expect(rowNotes(page, 'Notes: call the plumber')).toBeVisible();
    expect(await rowNotes(page, 'Notes: call the plumber').innerText()).toBe('Kitchen tap drips\n  and the shower head');
  });

  test('edits, cancels and clears notes with the keyboard only', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    const title = 'Notes: keyboard edit';
    await addTaskWithNotes(page, title, 'First line');
    const bodies = recordBodies(page);

    // Checkbox, Tab to Edit, Enter: the title field has focus; Tab reaches the notes.
    await checkbox(page, title).focus();
    await page.keyboard.press('Tab');
    await expect(editButton(page, title)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(editField(page, title)).toBeFocused();
    await tabTo(page, editNotes(page, title));
    await expect(editNotes(page, title)).toHaveValue('First line');
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await expect(editNotes(page, title)).toHaveValue('First line\nSecond line');
    // Shift+Tab goes back through the date to the title; Tab again comes back to the notes.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(editNotes(page, title)).toBeFocused();
    await screenshot(page, testInfo, 'notes-edit-row');

    // Escape cancels without a request; the stored notes stay.
    await page.keyboard.press('Escape');
    await expect(editButton(page, title)).toBeFocused();
    expect(bodies).toEqual([]);
    expect(await rowNotes(page, title).innerText()).toBe('First line');

    // Ctrl+Enter saves only the notes.
    await page.keyboard.press('Enter');
    await tabTo(page, editNotes(page, title));
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Second line');
    await page.keyboard.press('Control+Enter');
    await expect(editButton(page, title)).toBeFocused();
    expect(bodies).toEqual([{ method: 'PATCH', body: { notes: 'First line\nSecond line' } }]);
    expect(await rowNotes(page, title).innerText()).toBe('First line\nSecond line');

    // Emptying the field clears the notes.
    await page.keyboard.press('Enter');
    await tabTo(page, editNotes(page, title));
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+Enter');
    await expect(editButton(page, title)).toBeFocused();
    expect(bodies[1]).toEqual({ method: 'PATCH', body: { notes: null } });
    await expect(rowNotes(page, title)).toHaveCount(0);
    await page.reload();
    await expect(checkbox(page, title)).toBeVisible();
    await expect(rowNotes(page, title)).toHaveCount(0);
  });

  test('long notes are capped in a focusable scroll region; short notes are not', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    const long = 'Notes: long packing list';
    const short = 'Notes: short reminder';
    const lines = Array.from({ length: 40 }, (_, i) => `Item ${i + 1}: something to pack`);
    await addTaskWithNotes(page, long, lines.join('\n'));
    await addTaskWithNotes(page, short, 'Bring the blue bag');

    // Short: fully visible, no scroll bar, no Tab stop, no region.
    const shortNotes = rowNotes(page, short);
    await expect(shortNotes).toHaveText('Bring the blue bag');
    expect(await shortNotes.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    await expect(shortNotes).not.toHaveAttribute('tabindex');
    await expect(shortNotes).not.toHaveAttribute('role');
    await checkbox(page, short).focus();
    await page.keyboard.press('Tab');
    await expect(editButton(page, short)).toBeFocused();

    // Long: capped at 10rem (160px) with a vertical scroll bar, and a named,
    // focusable region right after the checkbox in Tab order.
    const region = page.getByRole('region', { name: `Notes for "${long}"`, exact: true });
    await expect(region).toBeVisible();
    await expect(region).toHaveAttribute('tabindex', '0');
    const size = await region.evaluate((element) => ({
      client: element.clientHeight,
      scroll: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      maxHeight: getComputedStyle(element).maxHeight,
    }));
    expect(size.client).toBeLessThan(size.scroll);
    expect(size.client).toBeLessThanOrEqual(160);
    expect(size).toMatchObject({ overflowY: 'auto', maxHeight: '160px' });
    await checkbox(page, long).focus();
    await page.keyboard.press('Tab');
    await expect(region).toBeFocused();
    // The keyboard scrolls it.
    await page.keyboard.press('End');
    await expect.poll(() => region.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.keyboard.press('Tab');
    await expect(editButton(page, long)).toBeFocused();
    await page.evaluate(() => window.scrollTo(0, 0));

    // At phone width nothing scrolls sideways, and a short note that wraps
    // stays uncapped.
    for (const [name, width] of [
      ['notes-narrow', 390],
      ['notes-wide', 1280],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      const noHorizontalScroll = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
      expect(noHorizontalScroll).toBe(true);
      await expect(region).toHaveAttribute('tabindex', '0');
      await expect(shortNotes).not.toHaveAttribute('tabindex');
      await region.scrollIntoViewIfNeeded();
      await screenshot(page, testInfo, name);
    }
  });

  test('the next occurrence of a repeating task shows the same notes', async ({ page }, testInfo) => {
    await signIn(page, 'Household One');
    const title = 'Notes: weekly bins';
    await page.getByLabel('New task').fill(title);
    await page.getByLabel('Due date', { exact: true }).fill('2026-11-20');
    await addRepeats(page).selectOption({ label: 'Weekly' });
    await notesToggle(page).click();
    await addNotes(page).fill('Green bin\nand the recycling');
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(openCheckbox(page, 'Today', title)).toBeVisible();

    await openCheckbox(page, 'Today', title).click();
    await expect(statusMessage(page)).toHaveText(`"${title}" is next due Fri, Nov 27.`);
    const next = groupList(page, 'Upcoming').getByRole('listitem').filter({ has: checkbox(page, title) });
    await expect(next.locator('[data-notes]')).toBeVisible();
    expect(await next.locator('[data-notes]').innerText()).toBe('Green bin\nand the recycling');
    await screenshot(page, testInfo, 'notes-next-occurrence');

    await page.reload();
    const reloaded = groupList(page, 'Upcoming').getByRole('listitem').filter({ has: checkbox(page, title) });
    expect(await reloaded.locator('[data-notes]').innerText()).toBe('Green bin\nand the recycling');
    await expandCompleted(page);
    const done = completedList(page).getByRole('listitem').filter({ has: checkbox(page, title) });
    expect(await done.locator('[data-notes]').innerText()).toBe('Green bin\nand the recycling');
  });
});
