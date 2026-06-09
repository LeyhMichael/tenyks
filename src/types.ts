export interface AppConfig {
  folder: string;
  name: string;
  description: string;
  icon: string;
  accent: string;
  author: string;
  tag?: string;
  status: 'live' | 'coming_soon';
  url: string;
}
