export type HunterScan = {
  id: string;
  created_at: string;
  market: string; // 'mx' | 'ca'
  industry: string;
  team_size: string;
  timesink: string;
  tools: string[];
  website_url: string | null;
  signals: HunterSignals | null;
  results: HunterResults | null;
  contacted: boolean;
  contacted_at: string | null;
};

export type HunterSignals = {
  reachable?: boolean;
  reason?: string;
  metaPixel?: boolean;
  analytics?: boolean;
  tiktokPixel?: boolean;
  emailCapture?: boolean;
  social?: {
    instagram?: boolean;
    facebook?: boolean;
    tiktok?: boolean;
    linkedin?: boolean;
    youtube?: boolean;
  };
  seo?: {
    ogTags?: boolean;
    metaDescription?: boolean;
    title?: boolean;
  };
  mobileViewport?: boolean;
};

export type HunterFinding = {
  title: string;
  solution: string;
  amount: number;
  frame: string;
};

export type HunterResults = {
  totalCost: number;
  totalGain: number;
  total: number;
  findings: HunterFinding[];
};

export type HunterAnalytics = {
  totalScans: number;
  scansThisWeek: number;
  totalContacted: number;
  contactRate: number;
  byMarket: { market: string; count: number; contacted: number }[];
  byIndustry: { industry: string; count: number; contacted: number }[];
  byTeamSize: { team_size: string; count: number }[];
  byTimesink: { timesink: string; count: number }[];
  topFindings: { title: string; count: number; industry: string }[];
  signalGaps: {
    noMetaPixel: number;
    noAnalytics: number;
    noEmailCapture: number;
    notReachable: number;
  };
  withWebsite: number;
  withoutWebsite: number;
  totalValueCAD: number;
  totalValueMXN: number;
  avgValueCAD: number;
  avgValueMXN: number;
};

export type HunterListOptions = {
  market?: string;
  industry?: string;
  contacted?: boolean;
  hasWebsite?: boolean;
  page?: number;
  pageSize?: number;
};
