import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Inbox, Layers, ListTodo, Plus, Settings2, UserCheck, Users } from 'lucide-react';
import { cn } from './cn';
import { BUILT_IN_VIEWS, type List, type View, viewItemId, viewName } from './lists';
import { focusRing, menuClass, menuItemClass } from './ui';

// For moving focus to the view title from elsewhere (see Tasks.tsx and
// ListBar.tsx): it stands in for controls that are gone, such as a tab or the
// New list button.
export const VIEW_TITLE_ID = 'view-title';
const MENU_ID = 'view-menu';

type Props = {
  lists: List[];
  // The view shown now (a missing list is already resolved to "All tasks").
  view: View;
  // New list and Manage lists are offered only once the lists loaded, and
  // Manage lists only when there is a list to manage.
  listActions: boolean;
  onSelect: (view: View) => void;
  onNewList: () => void;
  onManageLists: () => void;
};

// The view's name as the page title, and the button that opens the view
// picker: a menu of "All tasks", "Inbox", "Assigned to me" and the user's
// lists in creation order (menuitemradio, the shown one checked), then "New
// list" and "Manage lists". Arrow keys, Home and End move between the items
// (focus only; Enter, Space or a click chooses). Escape or a click outside
// closes it and hands focus back to the title; Tab closes it and moves on.
// The menu is open only while focus is in it: when focus goes elsewhere, or
// the item it was on leaves the page (a refresh took the list away, or the
// lists failed to load), the menu closes, in the second case with focus on
// the title, where the arrows open it again.
export function ViewPicker({ lists, view, listActions, onSelect, onNewList, onManageLists }: Props) {
  const [open, setOpen] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // The item to focus once the menu is on the page.
  const focusOnOpen = useRef<'checked' | 'first' | 'last'>('checked');
  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
  const focusItem = (where: 'checked' | 'first' | 'last') => {
    const all = items();
    const target =
      where === 'first'
        ? all[0]
        : where === 'last'
          ? all[all.length - 1]
          : (all.find((item) => item.getAttribute('aria-checked') === 'true') ?? all[0]);
    target?.focus();
  };
  useEffect(() => {
    if (!open) return;
    focusItem(focusOnOpen.current);
    const onPointer = (event: MouseEvent) => {
      if (holder.current?.contains(event.target as Node)) return;
      setOpen(false);
      // A click on something that takes focus keeps it; anywhere else, focus
      // goes back to the title instead of being dropped onto the page.
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body) trigger.current?.focus();
      }, 0);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  // After every render: an open menu whose focused item has left the page
  // (focus fell to the body) closes, and focus goes to the title, as after
  // Escape. This runs before Tasks' own refresh focus rules, which then find
  // focus on the page and leave it.
  useEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    if (!active || active === document.body) close();
  });

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const openWith = (where: 'checked' | 'first' | 'last') => {
    focusOnOpen.current = where;
    // Already open (focus is on the title): move into the menu now.
    if (open) focusItem(where);
    else setOpen(true);
  };
  // Focus moved away from the title and the menu (a save's error field, for
  // example): the menu closes and focus stays where it went.
  const onBlur = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !holder.current?.contains(next)) setOpen(false);
  };

  function onTriggerKeyDown(event: KeyboardEvent) {
    // Should focus be on the title while the menu is open, Escape still closes it.
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openWith(event.key === 'ArrowDown' ? 'checked' : 'last');
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const all = items();
    const index = all.indexOf(document.activeElement as HTMLElement);
    const last = all.length - 1;
    const next =
      event.key === 'ArrowDown'
        ? index >= last ? 0 : index + 1
        : event.key === 'ArrowUp'
          ? index <= 0 ? last : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null;
    if (next !== null) {
      event.preventDefault();
      all[next]?.focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      // Focus moves on from the title, as if the menu had not been open.
      setOpen(false);
    }
  }

  const choose = (item: View) => {
    close();
    onSelect(item);
  };
  const views: View[] = [...BUILT_IN_VIEWS, ...lists.map((list) => list.id)];
  return (
    <div ref={holder} onBlur={onBlur} className="relative min-w-0">
      <h1 className="m-0 min-w-0">
        <button
          ref={trigger}
          type="button"
          id={VIEW_TITLE_ID}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={MENU_ID}
          onClick={() => (open ? setOpen(false) : openWith('checked'))}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            '-ml-2 flex max-w-full min-w-0 cursor-pointer items-center gap-2 rounded-2xl border-0 bg-transparent px-2 py-1 text-left font-serif text-[34px] leading-[1.05] font-normal tracking-[-0.03em] text-ink transition-colors hover:bg-ink/5 sm:text-[40px]',
            focusRing,
          )}
        >
          <span className="min-w-0 break-words">{viewName(view, lists)}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'mt-1.5 size-5 shrink-0 text-ink-3 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </button>
      </h1>
      {/* On the page while closed too, hidden, so the title always controls it. */}
      <div
        ref={menu}
        id={MENU_ID}
        role="menu"
        aria-label="Views and lists"
        hidden={!open}
        onKeyDown={onMenuKeyDown}
        // A press on the menu's padding or a separator keeps focus on its item.
        onMouseDown={(event) => {
          if (!(event.target as Element).closest('[role^="menuitem"]')) event.preventDefault();
        }}
        className={cn(
          menuClass,
          'tk-pop absolute top-full left-0 z-40 mt-1 max-h-[min(70dvh,32rem)] w-64 max-w-[calc(100vw-2.5rem)] overflow-y-auto',
        )}
      >
        {views.map((item, index) => {
          const list = typeof item === 'number' ? lists.find((entry) => entry.id === item) : undefined;
          const Icon =
            item === 'all' ? Layers : item === 'inbox' ? Inbox : item === 'assigned' ? UserCheck : list?.shared ? Users : ListTodo;
          const checked = item === view;
          return (
            <div key={item} role="none">
              {index === BUILT_IN_VIEWS.length && <div role="separator" className="my-1 border-t border-dashed border-ink/10" />}
              <button
                type="button"
                role="menuitemradio"
                id={viewItemId(item)}
                aria-checked={checked}
                tabIndex={-1}
                onClick={() => choose(item)}
                className={cn(menuItemClass, 'text-[14px] pointer-coarse:min-h-11', checked && 'bg-ink/5')}
              >
                <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-3" strokeWidth={2.1} />
                <span className="min-w-0 flex-1 break-words">
                  {viewName(item, lists)}
                  {list?.shared && (
                    <>
                      {' '}
                      <span className="sr-only">(shared)</span>
                    </>
                  )}
                </span>
                {checked && <Check aria-hidden="true" className="size-4 shrink-0 text-accent" strokeWidth={2.4} />}
              </button>
            </div>
          );
        })}
        {listActions && (
          <>
            <div role="separator" className="my-1 border-t border-dashed border-ink/10" />
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                onNewList();
              }}
              className={cn(menuItemClass, 'text-[14px] text-ink-2 pointer-coarse:min-h-11')}
            >
              <Plus aria-hidden="true" className="size-4 shrink-0 text-ink-3" strokeWidth={2.2} />
              New list
            </button>
            {lists.length > 0 && (
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setOpen(false);
                  onManageLists();
                }}
                className={cn(menuItemClass, 'text-[14px] text-ink-2 pointer-coarse:min-h-11')}
              >
                <Settings2 aria-hidden="true" className="size-4 shrink-0 text-ink-3" strokeWidth={2.1} />
                Manage lists
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
