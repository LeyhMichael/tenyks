export interface AppConfig {
  folder: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  author: string;
  tag?: string;
  status: 'live' | 'coming_soon';
  visibility: 'public' | 'team';
  url: string;
}
