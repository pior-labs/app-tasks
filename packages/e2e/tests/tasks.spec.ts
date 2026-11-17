import { expect, type Page, type Request, test } from '@playwright/test';

// End-to-end checks in a real browser against the Vite dev server and the real
// API on a disposable database. Sign-in goes through the fixture SSO provider
// (packages/api/test/fixture.ts); no real credentials or hosted SSO are used.
//
// All tests share one database for the run, and "Household One" keeps the
// tasks earlier tests left behind. Each test therefore uses its own titles and
// only looks at those rows.

type FixtureUser = 'Household One' | 'Household Two';

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

  test.beforeEach(async ({ page }) => {
    // Friday 2026-11-20, noon in Toronto (17:00 UTC).
    await page.clock.install({ time: new Date('2026-11-20T12:00:00-05:00') });
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

  test('at local midnight a task due today moves to Overdue without a reload', async ({ page }) => {
    // 23:59:30 on Friday in Toronto.
    await page.clock.install({ time: new Date('2026-11-20T23:59:30-05:00') });
    await signIn(page, 'Household One');
    await addTaskDue(page, 'Midnight: take out the recycling', '2026-11-20');
    await addTaskDue(page, 'Midnight: call grandma', '2026-11-21');
    await expect(groupList(page, 'Today').getByText('Midnight: take out the recycling')).toBeVisible();
    await expect(rowOf(page, 'Midnight: call grandma').getByText('Due tomorrow')).toBeVisible();
    const loads: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/tasks') loads.push(request.url());
    });

    // Pass local midnight.
    await page.clock.runFor(60_000);
    await expect(groupList(page, 'Overdue').getByText('Midnight: take out the recycling')).toBeVisible();
    const moved = rowOf(page, 'Midnight: take out the recycling');
    await expect(moved.getByText('Overdue', { exact: true })).toBeVisible();
    await expect(moved.getByText('Due yesterday')).toBeVisible();
    await expect(groupList(page, 'Today').getByText('Midnight: call grandma')).toBeVisible();
    await expect(rowOf(page, 'Midnight: call grandma').getByText('Due today')).toBeVisible();
    expect(loads).toEqual([]);
  });
});

test.describe('due dates east of UTC', () => {
  test.use({ timezoneId: 'Pacific/Auckland', locale: 'en-US' });

  test('shows the stored date without shifting it', async ({ page }) => {
    // Noon on Friday 2026-11-20 in Auckland is still Thursday in UTC.
    await page.clock.install({ time: new Date('2026-11-20T12:00:00+13:00') });
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
