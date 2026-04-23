import { useCallback, useEffect, useRef } from "react";

export function useStableCallback<Args extends unknown[], ReturnValue>(
  callback: (...args: Args) => ReturnValue,
) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback((...args: Args) => callbackRef.current(...args), []);
}
