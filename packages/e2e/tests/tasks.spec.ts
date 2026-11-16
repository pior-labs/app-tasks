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

const taskList = (page: Page) => page.getByRole('list', { name: 'Your tasks' });
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
// clicks and then waits, instead of expecting an immediate change.
async function complete(page: Page, title: string) {
  await checkbox(page, title).click();
  await expect(checkbox(page, title)).toBeChecked();
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

  await complete(page, 'Start: buy oat milk');

  await page.reload();
  // Newest first, and the completion state came back from the database.
  await expectOrder(page, ['Start: water the plants', 'Start: buy oat milk']);
  await expect(checkbox(page, 'Start: buy oat milk')).toBeChecked();
  await expect(checkbox(page, 'Start: water the plants')).not.toBeChecked();
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
  // Renaming changed neither the completion state nor the position in the list.
  await expect(checkbox(page, 'Keyboard: buy oat milk')).toBeChecked();
  const order = ['Keyboard: newer', 'Keyboard: buy oat milk', 'Keyboard: older'];
  await expectOrder(page, order);
  expect(writes).toEqual(['PATCH /api/tasks/:id']);

  await page.reload();
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
  await expect(other.getByRole('list', { name: 'Your tasks' })).toHaveCount(0);
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
