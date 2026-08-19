// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

export interface VisualContinuityState {
  characterStates: Record<string, string>; // characterId -> characterStateId
  costume: Record<string, string>;
  hair: Record<string, string>;
  injury: Record<string, string>;
  heldItems: Record<string, string[]>;
  location: string;
  timeOfDay: string;
  weather: string;
  wind: string;
  screenDirection: string;
  facing: string;
  vehicleState: Record<string, string>;
  notes: string;
}

export interface ContinuityEntry {
  id: string;
  shotId: string;
  scope: 'visual' | 'narrative';
  kind: 'planned' | 'actual';
  sourceTakeId: string | null;
  state: VisualContinuityState | null;
  narrative: NarrativeState | null;
  committedAt: string;
  createdAt: string;
}

export interface NarrativeState {
  knowledge: string[];
  relationships: string[];
  dramaticState: string;
  goals: string[];
  knownEvents: string[];
}
