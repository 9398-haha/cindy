import Reanimated, { useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';

/**
 * iOS new task: the space under the composer, tracked on the UI
 * thread every keyboard frame. The composer stays at the new-task button's bottom edge
 * until the keyboard reaches it, then rides the keyboard with a fixed gap,
 * instead of jumping to its final place when the keyboard event arrives.
 * Mounted only on the iOS composer dock; other layouts keep the shared keyboard state.
 */
export function ComposerDockKeyboardSpacer({ restingBottom, keyboardGap }: { restingBottom: number; keyboardGap: number }) {
  const keyboard = useAnimatedKeyboard();
  const style = useAnimatedStyle(() => ({ height: Math.max(restingBottom, keyboard.height.value + keyboardGap) }));
  return <Reanimated.View pointerEvents="none" style={style} />;
}
