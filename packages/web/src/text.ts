// Text rules shared by task titles and list names. They mirror the server
// (packages/api/src/tasks.ts) so the forms and the API agree. A text made only
// of whitespace, control characters and invisible "default ignorable" code
// points (such as a zero width space) is treated as empty; visible text is
// sent unchanged apart from trimming.
export const VISIBLE_CHARACTER = /[^\p{White_Space}\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

// Length is counted in Unicode code points, so an emoji is one character.
export function characterCount(text: string) {
  let count = 0;
  for (const _character of text) count++;
  return count;
}
