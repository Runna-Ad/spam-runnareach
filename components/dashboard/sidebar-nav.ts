import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Brain,
  Building2,
  FileText,
  Filter,
  Flame,
  Inbox,
  LayoutDashboard,
  LineChart,
  ScrollText,
  Search,
  Sigma,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Target,
  Trophy,
} from "lucide-react";

export type NavSection = {
  label: string;
  items: NavItem[];
};

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Phase where this route becomes functional. Placeholder until that phase ships. */
  phase: 0 | 1 | 2 | 3 | 4 | 5 | 6;
};

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    label: "Pipeline",
    items: [
      { label: "Today", href: "/dashboard", icon: LayoutDashboard, phase: 0 },
      { label: "Discover", href: "/discover", icon: Search, phase: 1 },
      { label: "Companies", href: "/companies", icon: Building2, phase: 1 },
      { label: "Pitches", href: "/pitches", icon: Send, phase: 3 },
      { label: "Funnel", href: "/funnel", icon: Filter, phase: 4 },
      { label: "Opportunities", href: "/opportunities", icon: Trophy, phase: 5 },
      { label: "Inbox", href: "/inbox", icon: Inbox, phase: 5 },
    ],
  },
  {
    label: "Learn",
    items: [
      { label: "Analytics", href: "/analytics", icon: BarChart3, phase: 5 },
      { label: "Learning", href: "/learning", icon: Brain, phase: 5 },
    ],
  },
  {
    label: "Library",
    items: [
      { label: "Case Studies", href: "/case-studies", icon: ScrollText, phase: 0 },
      { label: "Notable Clients", href: "/notable-clients", icon: Star, phase: 0 },
      { label: "Benchmarks", href: "/benchmarks", icon: Sigma, phase: 0 },
      { label: "ICP", href: "/icp", icon: Target, phase: 0 },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Compliance", href: "/compliance", icon: ShieldCheck, phase: 0 },
      { label: "Deliverability", href: "/analytics?tab=deliverability", icon: LineChart, phase: 4 },
      { label: "Warmup", href: "/warmup", icon: Flame, phase: 0 },
      { label: "Design", href: "/design", icon: FileText, phase: 0 },
      { label: "Settings", href: "/settings/profile", icon: Settings, phase: 0 },
    ],
  },
] as const;
