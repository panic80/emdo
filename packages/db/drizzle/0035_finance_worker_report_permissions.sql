-- Production activates the executor role with SET LOCAL ROLE. Grant only the
-- revision-bound dispatcher and atomic report functions; no direct table writes,
-- readiness mutation, role membership, or row-security bypass is introduced.
GRANT EXECUTE ON FUNCTION emdo.claim_finance_automation_delivery(uuid,integer),
  emdo.settle_finance_automation_run(uuid,integer,uuid,text,uuid),
  emdo.generate_finance_trial_balance(uuid,integer,uuid)
TO emdo_worker_executor;
