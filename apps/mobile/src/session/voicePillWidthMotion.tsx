import { useEffect, type ReactNode } from 'react';
import Reanimated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { getCachedReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { motionDuration, motionEasing } from '@/theme/tokens';

/**
 * 录音胶囊宽度的过渡(§14.4 尺寸变化档:motionDuration.base + motionEasing.move)。
 *
 * 原先靠 RN LayoutAnimation.configureNext,但 Reanimated 接管了 Fabric 挂载层,
 * LayoutAnimation 在本 App 里是静默 no-op,胶囊展开 / 收回一直是跳变。这里改为
 * Reanimated 直接驱动宽度:语音按钮外框与工具排占位各用一份,同一次渲染里起跑、
 * 同时长同曲线,胶囊向左生长与左邻按钮的让位在同一段运动里完成。系统开启
 * 「减弱动态效果」时直接落位。
 */
export function useVoicePillWidthStyle(width: number) {
  const animated = useSharedValue(width);
  useEffect(() => {
    animated.value = getCachedReduceMotionEnabled() === false
      ? withTiming(width, { duration: motionDuration.base, easing: Easing.bezier(...motionEasing.move) })
      : width;
  }, [animated, width]);
  return useAnimatedStyle(() => ({ width: animated.value }));
}

/** 语音按钮外框:宽度随胶囊平滑变化,按钮本身撑满外框(width: '100%')。 */
export function VoicePillWidthFrame({ children, width }: { children: ReactNode; width: number }) {
  const style = useVoicePillWidthStyle(width);
  return <Reanimated.View style={style}>{children}</Reanimated.View>;
}
