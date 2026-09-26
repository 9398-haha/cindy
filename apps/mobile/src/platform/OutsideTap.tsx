import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { View, type GestureResponderEvent } from "react-native";

type OutsideTapListener = {
  /** Window coordinates, same space as `measureInWindow` and touch pageX/pageY. */
  contains: (x: number, y: number) => boolean;
  onOutsideTap: () => void;
};

type Subscribe = (listener: OutsideTapListener) => () => void;

const OutsideTapContext = createContext<Subscribe>(() => () => {});

/** Movement beyond this is a drag or scroll, not a tap. */
export const OUTSIDE_TAP_SLOP = 8;

/**
 * Observes raw touches without claiming the responder, so floating panels can
 * close on an outside tap while everything underneath keeps scrolling normally.
 */
export function OutsideTapProvider({ children }: { children: ReactNode }) {
  const listeners = useRef(new Set<OutsideTapListener>());
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const subscribe = useRef<Subscribe>((listener) => {
    listeners.current.add(listener);
    return () => listeners.current.delete(listener);
  }).current;
  return (
    <OutsideTapContext.Provider value={subscribe}>
      <View
        style={{ flex: 1 }}
        onTouchStart={(event: GestureResponderEvent) => {
          const { pageX, pageY, touches } = event.nativeEvent;
          // A second finger turns the gesture into a pinch; never a tap.
          if (touches.length > 1 && touch.current) touch.current.moved = true;
          else
            touch.current = { x: pageX, y: pageY, moved: touches.length > 1 };
        }}
        onTouchMove={(event: GestureResponderEvent) => {
          const start = touch.current;
          if (
            start &&
            Math.hypot(
              event.nativeEvent.pageX - start.x,
              event.nativeEvent.pageY - start.y,
            ) > OUTSIDE_TAP_SLOP
          )
            start.moved = true;
        }}
        onTouchEnd={(event: GestureResponderEvent) => {
          if (event.nativeEvent.touches.length > 0) return;
          const start = touch.current;
          touch.current = null;
          if (!start || start.moved) return;
          for (const listener of [...listeners.current]) {
            if (!listener.contains(start.x, start.y)) listener.onOutsideTap();
          }
        }}
        // Native scroll views cancel JS touches when they take over the gesture.
        onTouchCancel={() => {
          touch.current = null;
        }}
      >
        {children}
      </View>
    </OutsideTapContext.Provider>
  );
}

/** While active, calls `onOutsideTap` for taps that start outside `contains`. */
export function useOutsideTap(
  active: boolean,
  contains: OutsideTapListener["contains"],
  onOutsideTap: () => void,
) {
  const subscribe = useContext(OutsideTapContext);
  const latest = useRef({ contains, onOutsideTap });
  latest.current = { contains, onOutsideTap };
  useEffect(() => {
    if (!active) return;
    return subscribe({
      contains: (x, y) => latest.current.contains(x, y),
      onOutsideTap: () => latest.current.onOutsideTap(),
    });
  }, [active, subscribe]);
}
