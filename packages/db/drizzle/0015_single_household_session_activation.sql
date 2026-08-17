CREATE OR REPLACE FUNCTION emdo.resolve_exactly_one_active_household_for_auth_session(
	p_user_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, emdo
SET row_security = on
AS $function$
	SELECT membership.household_id
	FROM emdo.household_memberships AS membership
	WHERE membership.user_id = p_user_id
		AND membership.status = 'active'
		AND membership.ended_at IS NULL
		AND NOT EXISTS (
			SELECT 1
			FROM emdo.household_memberships AS other_membership
			WHERE other_membership.user_id = p_user_id
				AND other_membership.status = 'active'
				AND other_membership.ended_at IS NULL
				AND other_membership.household_id <> membership.household_id
		)
$function$;
--> statement-breakpoint
ALTER FUNCTION emdo.resolve_exactly_one_active_household_for_auth_session(uuid)
	OWNER TO emdo_policy_reader;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
	emdo.resolve_exactly_one_active_household_for_auth_session(uuid)
	FROM PUBLIC, emdo_app, emdo_auth, emdo_worker, emdo_workflow,
	emdo_policy_reader;
GRANT EXECUTE ON FUNCTION
	emdo.resolve_exactly_one_active_household_for_auth_session(uuid)
	TO emdo_auth;
