-- 0026_prospect_b_list_status.sql
-- "B-list" tier for prospects scored 50-69: above the auto-suppress floor (<50)
-- but below the auto-pitch bar (>=70). Kept as a time-boxed, opt-in review pool
-- (out of the default working view, auto-suppressed after 21 days untouched) so
-- genuine near-misses (scoring noise near the threshold) stay reachable without
-- cluttering the A-list. Scores <50, and >=70-with-no-contact, are auto-suppressed.

alter type prospect_status add value if not exists 'b_list';
