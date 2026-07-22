-- Benchmark rows fitted to the ACTUAL prospect base.
--
-- The first seed (0030) was thin because the best-sourced benchmarks in
-- marketing are ecommerce benchmarks, and this tenant's pipeline is 1%
-- ecommerce. This round researched the industries actually pitched:
-- manufacturers (212), accounting and law firms (201), hospitals (72),
-- distribution and wholesale (140), consumer venues (60).
--
-- Every figure below was read first-hand from the publisher's own page or PDF.
-- That is not a formality — verification changed three rows:
--   • The HBR lead-response study is paywalled, but a full-text PDF exists and
--     was read directly, so the numbers are confirmed rather than recalled.
--   • A claimed Clio figure ("18% gave clear next steps or cost information")
--     is NOT on the cited page and is therefore omitted; only the three
--     reachability figures are seeded.
--   • GlobalSpec's credibility finding is seeded in the report's OWN wording
--     ("almost twice as likely... than a prominent trade show sponsorship"),
--     not as a reconstructed 4.0-out-of-5 ranking that could not be confirmed.
--
-- is_active is FALSE on every row. Pedro activates after reading the caveats.

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
    'A Harvard Business Review audit of 2,241 companies found 23% never responded at all to a web enquiry, and among those that did, the average reply took 42 hours.',
    '23%',
    array['manual_sales_process'],
    -- The broadest-fitting row in the table: every one of these industries
    -- takes enquiries through a web form.
    array['accounting firm', 'chartered accountant', 'law firm', 'despacho de abogados',
          'manufacturer', 'manufacturing', 'distribution', 'distributor', 'wholesale',
          'wholesale distributor', 'real estate agency', 'inmobiliaria', 'construction',
          'software development'],
    null,
    'https://hbr.org/2011/03/the-short-life-of-online-sales-leads',
    'Harvard Business Review (Oldroyd, McElheran, Elkington)',
    date '2011-03-01',
    false,
    'Read first-hand from a full-text PDF of the article; the HBR page itself is paywalled. Verbatim: "We audited 2,241 U.S. companies... 23% of the companies never responded at all. The average response time, among companies that responded within 30 days, was 42 hours." THREE caveats before quoting: (1) it is 2011 — quote it as "a Harvard Business Review audit" and be ready to defend the date; (2) US companies only; (3) co-author David Elkington was chairman/CEO of InsideSales.com, which sold lead-response software — disclosed in the article, but it is a commercial interest in the finding. The article explicitly names healthcare and professional services among the industries studied.'
  ),
  (
    'Firms that contacted an enquiry within an hour were nearly 7 times as likely to qualify the lead as those that waited just one hour longer, and more than 60 times as likely as those that waited a day.',
    '7 times',
    array['manual_sales_process'],
    array['accounting firm', 'chartered accountant', 'law firm', 'despacho de abogados',
          'manufacturer', 'manufacturing', 'distribution', 'distributor', 'wholesale',
          'real estate agency', 'inmobiliaria', 'construction'],
    null,
    'https://hbr.org/2011/03/the-short-life-of-online-sales-leads',
    'Harvard Business Review (Oldroyd, McElheran, Elkington)',
    date '2011-03-01',
    false,
    'Same article, but a SEPARATE study referenced within it: 1.25M leads across 29 B2C and 13 B2B US companies, with no standalone methodology writeup. Weaker than the 23%/42-hour row — prefer that one. Note the precise claim: "qualify" is defined in the article as "having a meaningful conversation with a key decision maker", NOT closing a sale. Blogs routinely mangle this into "7x more likely to convert", which is wrong.'
  ),
  (
    'When researchers posed as prospective clients and contacted 500 law firms, only 33% replied to the email and only 40% answered the phone.',
    '33%',
    array['manual_sales_process', 'no_proof'],
    array['law firm', 'despacho de abogados'],
    null,
    'https://www.2civility.org/2024-clio-legal-trends-report-fixing-the-first-impression-problem-for-law-firms/',
    'Clio Legal Trends Report (secret-shopper study by Lux), reported by 2Civility',
    date '2024-11-01',
    true,
    'Verified on the 2Civility page: "Just 33% of firms responded to the emails (down from 40% in 2019)" and "Only 40% of firms answered the phone calls (down from 56% in 2019)"; 48% were unreachable by both. A behavioural audit, not a self-report survey, which makes it stronger than most vendor research, and it was reported by the Illinois Supreme Court Commission on Professionalism. CAVEATS: the 500 firms are US (Clio is Canadian-headquartered, but this shop was not); and Clio sells intake software, so the finding flatters their product. A separate claimed figure about firms giving cost information could NOT be verified on the source page and is deliberately not included here.'
  ),
  (
    'Technical buyers now spend about 60% of the buying process online before they talk to anyone, and 73% routinely turn to vendor websites and technical publications for information.',
    '60%',
    array['outdated_website', 'unclear_value_prop', 'manual_sales_process'],
    array['manufacturer', 'manufacturing', 'distribution', 'distributor',
          'wholesale', 'wholesale distributor', 'software development'],
    null,
    'https://advertising.globalspec.com/wp-content/uploads/2025/02/SMTE_2025.pdf',
    'GlobalSpec + TREW Marketing + Elektor, State of Marketing to Engineers 2025',
    date '2025-02-01',
    true,
    'Read first-hand from the report PDF, Key Takeaways p.7. n=1,132 engineers and technical professionals; 58% work at companies of 1-250 employees, which fits an SMB manufacturer base well. Vendor-sourced but unusually transparent — every chart carries its own n. CAVEAT: global sample with the Americas at 38%, not broken out to Canada; and it skews toward electronics and engineering-heavy manufacturing, so it is a looser fit for pure distributors than for manufacturers.'
  ),
  (
    'Technical buyers are almost twice as likely to treat a strong website as a signal of a credible supplier than a prominent trade-show sponsorship.',
    'twice',
    array['outdated_website', 'no_proof', 'unclear_value_prop'],
    array['manufacturer', 'manufacturing', 'distribution', 'distributor',
          'wholesale', 'wholesale distributor'],
    null,
    'https://advertising.globalspec.com/wp-content/uploads/2025/02/SMTE_2025.pdf',
    'GlobalSpec + TREW Marketing + Elektor, State of Marketing to Engineers 2025',
    date '2025-02-01',
    true,
    'Quoted in the report''s OWN wording from Key Takeaways p.7. A more precise ranking (website 4.0/5 vs references 3.8, case studies 3.6, trade shows 2.8) was reported by the researcher but sits in a detail chart that was not verified, so the headline comparison is used instead. Same sample caveats as the 60% row. Note this is a comparison, not a percentage — the send gate will not flag it as a metric.'
  ),
  (
    '78% of Canadian small businesses have a website, but only 70% of those with fewer than five employees do, against 91% of firms with 50 or more.',
    '78%',
    array['outdated_website'],
    -- Deliberately unscoped by industry: this is a Canada-wide SMB baseline
    -- across all sectors, which is exactly what makes it usable broadly.
    array[]::text[],
    'CA',
    'https://www.cfib-fcei.ca/en/research-economic-analysis/sme-digital-presence',
    'Canadian Federation of Independent Business (CFIB)',
    date '2025-12-17',
    false,
    'Verified on the CFIB page. n=2,478 Canadian independent business owners, all sectors, fielded 11-25 September 2025. The strongest geographic fit in the table: Canadian, recent, large, and published by a genuine industry association with nothing to sell. The PITCHABLE part is the size gradient (70% micro vs 91% large) — it establishes that a weak web presence is specifically a small-firm problem. CAVEAT: "has a website" says nothing about quality; do not stretch it into a claim about BAD websites.'
  )
) as v(statistic, figure, pain_codes, industry_scope, market,
       source_url, publisher, published_date, is_vendor_sourced, caveat)
where t.code = 'RUNNA_CA'
on conflict do nothing;
