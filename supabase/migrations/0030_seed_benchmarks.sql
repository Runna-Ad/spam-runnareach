-- First benchmark rows.
--
-- Every figure below was fetched from the publisher's own page or PDF and read
-- directly — not taken from a search snippet, and not recalled. That mattered:
-- verification killed a Triple Whale ROAS row (its page states BOTH 1.86 and
-- 1.93 for the same 2025 median, so it is not quotable), and confirmed that the
-- ubiquitous Bain "5% retention → 25-95% profit" range appears NOWHERE in the
-- Bain document everyone attributes it to. The real sentence is narrower and
-- financial-services-specific.
--
-- SCOPE IS THE POINT, NOT THE PADDING.
-- The best-sourced marketing benchmarks in existence are ecommerce benchmarks
-- (Baymard checkout, Spiegel product reviews, Omnisend DTC email). Measured
-- against this tenant's actual 838 prospects, ecommerce is 1%. The base is
-- manufacturers (212), accounting and law firms (201), hospitals (72),
-- distribution and wholesale (140), spas/salons/fitness (60). Cart abandonment
-- means nothing to a manufacturer.
--
-- So only rows that fit that base are seeded here, and each one's
-- industry_scope is deliberately narrow. A benchmark quoted at the wrong
-- industry is worse than no benchmark: a statistic reads as researched, so
-- getting it wrong costs more credibility than staying qualitative.
--
-- is_active is FALSE on every row. Pedro activates them after reading the
-- caveats, because he is the one who defends the number if a prospect asks.

insert into public.benchmarks (
  tenant_id, statistic, figure, pain_codes, industry_scope, market,
  source_url, publisher, published_date, is_vendor_sourced, caveat, is_active
)
select
  t.id, v.statistic, v.figure, v.pain_codes, v.industry_scope, v.market,
  v.source_url, v.publisher, v.published_date, v.is_vendor_sourced, v.caveat, false
from public.tenants t
cross join (values
  (
    'A 0.1-second improvement in mobile load time cut bounce rate on lead-generation information pages by 8.3%.',
    '8.3%',
    array['outdated_website', 'poor_mobile_conversion'],
    -- Lead-gen scope only. The same study's retail conversion figure (8.4%) is
    -- deliberately NOT seeded: it measures transactional retail sites, and
    -- quoting it to a law firm or a manufacturer would be the exact
    -- cross-industry non-sequitur this table exists to prevent.
    array['accounting firm', 'law firm', 'chartered accountant', 'despacho de abogados',
          'manufacturer', 'manufacturing', 'real estate agency', 'inmobiliaria',
          'distribution', 'distributor', 'wholesale'],
    'GLOBAL',
    'https://www.thinkwithgoogle.com/_qs/documents/9757/Milliseconds_Make_Millions_report_hQYAbZJ.pdf',
    'Deloitte Digital + 55, commissioned by Google',
    date '2020-01-01',
    false,
    'Read directly from the PDF (Key Findings, p.5). Observational correlation over a 4-week window across 37 retail, travel, luxury and lead-generation brands in Europe and the US — not a controlled experiment, and a small brand sample. Now ~6 years old; nothing newer of comparable scale was found. Use the 8.3% bounce figure for lead-gen/professional-services sites ONLY.'
  ),
  (
    'The median Instagram engagement rate across consumer industries is 0.36% of followers per post.',
    '0.36%',
    array['poor_social_engagement', 'no_content_velocity'],
    -- Consumer-facing venues only. Rival IQ's 14 industries are all consumer
    -- brand categories, so this is meaningless for B2B, trades or professional
    -- services — hence no manufacturers, accountants or law firms here.
    array['spa', 'salón de belleza', 'fitness studio', 'restaurant group',
          'hotel chain', 'restaurant', 'hotel'],
    'GLOBAL',
    'https://www.rivaliq.com/blog/good-engagement-rate-instagram/',
    'Rival IQ',
    date '2025-01-01',
    true,
    'Verified on the publisher page. TWO caveats that must be respected when quoting: (1) engagement here is interactions divided by TOTAL FOLLOWERS, which is not how Instagram''s own analytics computes it (reach-based) — a prospect checking their dashboard will see a different number and may think we are wrong, so define the denominator; (2) the 14 industries are all consumer categories. Rival IQ says ~0.36% while Emplifi reports ~9.7% for the same platform because the denominators differ — never mix vendors.'
  )
) as v(statistic, figure, pain_codes, industry_scope, market,
       source_url, publisher, published_date, is_vendor_sourced, caveat)
where t.code = 'RUNNA_CA'  -- verified against the live tenants row, not assumed
on conflict do nothing;
