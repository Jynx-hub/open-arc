// Runs in the isolated world of every top-level page of a Profile session (never iframes, never private
// windows). Tells the browser when the user reaches a sign-in field, fills the login the user picks in the
// browser's own menu, and reports a sign-in form the user sent. The menu is native, drawn by the browser
// outside the page, so the page can't hide, cover or click it. Main decides the origin from the sender.
import { ipcRenderer } from 'electron';

/** A user action (click, key) this recent makes a focus or a form submit the user's own. */
const USER_MS = 1000;

let lastUserAction = 0;
let target: HTMLInputElement | null = null;

if (/^https?:$/.test(location.protocol)) {
  for (const t of ['mousedown', 'keydown']) window.addEventListener(t, (e) => e.isTrusted && (lastUserAction = Date.now()), true);
  const start = () => watch();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  ipcRenderer.on('pw:fill', (_e, username: string, password: string) => {
    const pw = target;
    if (!pw?.isConnected || !visible(pw)) return;
    const user = usernameFor(pw);
    if (user) setValue(user, username);
    setValue(pw, password);
  });
}

const fromUser = () => Date.now() - lastUserAction < USER_MS;

function watch() {
  const seen = new WeakSet<HTMLInputElement>();
  const scan = () => {
    for (const pw of document.querySelectorAll<HTMLInputElement>('input[type=password]')) {
      if (seen.has(pw)) continue;
      seen.add(pw);
      // A click on the field, or reaching it with the keyboard. A page calling focus() itself doesn't count.
      const offer = (e: Event) => {
        const field = e.target as HTMLInputElement;
        if (!e.isTrusted || (e.type === 'focus' && !fromUser()) || !visible(pw) || !visible(field)) return;
        target = pw;
        const r = field.getBoundingClientRect();
        ipcRenderer.send('pw:offer', { x: r.left, y: r.bottom + 4 });
      };
      for (const field of [pw, usernameFor(pw)]) {
        if (!field) continue;
        field.addEventListener('focus', offer);
        field.addEventListener('mousedown', offer);
      }
      pw.addEventListener('keydown', (e) => e.isTrusted && e.key === 'Enter' && report(pw));
      // requestSubmit() from page script also fires this: only a submit right after a user action counts.
      pw.form?.addEventListener('submit', () => fromUser() && report(pw), true);
    }
  };
  // Submit buttons whose page sends with script (no form submit) still count as sending the form.
  document.addEventListener(
    'click',
    (e) => {
      const button = e.isTrusted && (e.target as Element | null)?.closest?.('button, input[type=submit]');
      if (!button || (button as HTMLButtonElement).type !== 'submit') return;
      const form = (button as HTMLButtonElement).form ?? button.closest('form');
      const pw = [...(form ?? document).querySelectorAll<HTMLInputElement>('input[type=password]')].reverse().find((x) => x.value);
      if (pw) report(pw);
    },
    true,
  );
  scan();
  // After a sign-in navigation, a page still asking for a password means the sign-in failed.
  setTimeout(() => ipcRenderer.send('pw:loaded', [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].some(visible)), 800);
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      scan();
    }, 200);
  }).observe(document.documentElement, { childList: true, subtree: true });
}

/** The field the username goes in: one marked as such, else the last text-like field before the password. */
function usernameFor(pw: HTMLInputElement): HTMLInputElement | null {
  const scope = pw.form ?? document;
  const inputs = [...scope.querySelectorAll<HTMLInputElement>('input')];
  const before = inputs.slice(0, inputs.indexOf(pw));
  const marked = before.find((i) => /\busername\b/.test(i.autocomplete) || /\bemail\b/.test(i.autocomplete));
  return marked ?? before.reverse().find((i) => ['text', 'email', 'tel', ''].includes(i.type) && i.offsetParent !== null) ?? null;
}

let lastReport = '';
function report(pw: HTMLInputElement) {
  // A change-password form has the new password last.
  const all = [...(pw.form ?? document).querySelectorAll<HTMLInputElement>('input[type=password]')].filter((x) => x.value);
  const password = all[all.length - 1]?.value ?? pw.value;
  const username = usernameFor(pw)?.value ?? '';
  const key = `${username}\n${password}`;
  if (!password || key === lastReport) return;
  lastReport = key;
  ipcRenderer.send('pw:submitted', username, password);
  // A single-page app that signs in without navigating removes or hides the form.
  const started = Date.now();
  const timer = setInterval(() => {
    if (!pw.isConnected || !visible(pw)) {
      clearInterval(timer);
      ipcRenderer.send('pw:gone');
    } else if (Date.now() - started > 10_000) clearInterval(timer);
  }, 500);
}

/** On screen for real: has a size, and neither it nor an ancestor is hidden or transparent. */
function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
}

function setValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}
