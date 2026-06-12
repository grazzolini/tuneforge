import { useMemo, useState, type ReactNode } from "react";
import { ChordDictionaryFollowArmContext } from "./chordDictionaryFollowArm-context";

export function ChordDictionaryFollowArmProvider({ children }: { children: ReactNode }) {
  const [manualFollowArmed, setManualFollowArmed] = useState(false);
  const value = useMemo(
    () => ({
      manualFollowArmed,
      setManualFollowArmed,
    }),
    [manualFollowArmed],
  );

  return (
    <ChordDictionaryFollowArmContext.Provider value={value}>
      {children}
    </ChordDictionaryFollowArmContext.Provider>
  );
}
