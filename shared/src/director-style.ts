export interface DirectorStylePreset {
  id: string;
  name: string;
  aliases: string[];
  tags: string[];
  medium: string[];
  productionDesign: string[];
  lighting: string[];
  performance: string[];
  camera: string[];
  editing: string[];
  sound: string[];
  avoid: string[];
}

export interface ResolvedDirectorStyle {
  userQuery: string;
  preset: DirectorStylePreset | null;
  match: 'alias' | 'tag' | 'custom' | 'none';
}
