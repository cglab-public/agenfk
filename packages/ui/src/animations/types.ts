export type AnimationTrigger = 'enter' | 'exit';

export interface EasterEggAnimation {
  name: string;
  /** React component that wraps the card content and performs the animation */
  Wrapper: React.FC<AnimationWrapperProps>;
}

export interface AnimationWrapperProps {
  trigger: AnimationTrigger;
  onComplete: () => void;
  children: React.ReactNode;
  cardRect?: DOMRect | null;
}
