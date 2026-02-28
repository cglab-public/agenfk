import { EasterEggAnimation } from './types';

const animations: EasterEggAnimation[] = [];

export function registerAnimation(animation: EasterEggAnimation): void {
  animations.push(animation);
}

export function getRandomAnimation(): EasterEggAnimation | null {
  if (animations.length === 0) return null;
  return animations[Math.floor(Math.random() * animations.length)];
}

export function getAllAnimations(): EasterEggAnimation[] {
  return [...animations];
}
