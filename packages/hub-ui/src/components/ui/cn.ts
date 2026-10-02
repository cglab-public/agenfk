import clsx, { ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Join classes and let later ones win (a caller's `className` overrides a default). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
