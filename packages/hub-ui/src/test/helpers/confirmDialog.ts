import { vi } from 'vitest';
import { screen, within, fireEvent } from '@testing-library/react';

/**
 * Drive the shared ConfirmDialog the way an admin does. `answer` clicks the
 * confirm button (true) or Cancel (false) and returns the dialog's text, so a
 * test can check the consequence it stated.
 */
export async function answerConfirm(answer: boolean): Promise<string> {
  const dialog = await screen.findByRole('dialog');
  const text = dialog.textContent ?? '';
  const buttons = within(dialog).getAllByRole('button');
  const cancel = buttons.find(b => b.textContent?.trim() === 'Cancel');
  const confirm = buttons.find(b => b !== cancel);
  if (!cancel || !confirm) throw new Error(`dialog has no Cancel/confirm pair: ${text}`);
  fireEvent.click(answer ? confirm : cancel);
  return text;
}

/** Make any fallback to the browser's own dialog fail loudly. Returns the spy. */
export function forbidWindowConfirm() {
  return vi.spyOn(window, 'confirm').mockImplementation(() => { throw new Error('window.confirm must not be used'); });
}

/**
 * A mutation reaches the api a few ticks after mutate(). Wait this long before
 * claiming a declined dialog sent nothing, so a wrongly dispatched one lands.
 */
export const letMutationsLand = () => new Promise(r => setTimeout(r, 30));
