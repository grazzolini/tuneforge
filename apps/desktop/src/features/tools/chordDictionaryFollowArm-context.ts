import { createContext, useContext } from "react";

export type ChordDictionaryFollowArmContextValue = {
  manualFollowArmed: boolean;
  setManualFollowArmed: (armed: boolean) => void;
};

export const ChordDictionaryFollowArmContext =
  createContext<ChordDictionaryFollowArmContextValue | null>(null);

export function useChordDictionaryFollowArm() {
  const context = useContext(ChordDictionaryFollowArmContext);
  if (!context) {
    throw new Error(
      "useChordDictionaryFollowArm must be used within a ChordDictionaryFollowArmProvider.",
    );
  }
  return context;
}
