export const up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION enforce_account_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
      plan_is_predefined boolean;
    BEGIN
      IF NEW.account_plan_id IS NULL THEN
        IF NEW.account_plan_owner_account_id IS NOT NULL THEN
          RAISE EXCEPTION 'An account plan owner cannot be set without a plan'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      SELECT owner_account_id, is_predefined
      INTO plan_owner, plan_is_predefined
      FROM account_plans WHERE id = NEW.account_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Account plan % does not exist', NEW.account_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_is_predefined AND plan_owner IS NOT NULL THEN
        RAISE EXCEPTION 'Predefined account plans must not have an owner account'
          USING ERRCODE = '23514';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.id THEN
        RAISE EXCEPTION 'Custom account plans can only be assigned to their owner'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' OR NEW.account_plan_id IS DISTINCT FROM OLD.account_plan_id THEN
        NEW.account_plan_owner_account_id := plan_owner;
      ELSIF NEW.account_plan_owner_account_id IS DISTINCT FROM plan_owner THEN
        RAISE EXCEPTION 'Account plan owner does not match the selected plan'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION enforce_user_plan_ownership() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      plan_owner uuid;
      plan_is_predefined boolean;
    BEGIN
      IF NEW.user_plan_id IS NULL THEN
        IF NEW.user_plan_owner_account_id IS NOT NULL THEN
          RAISE EXCEPTION 'A user plan owner cannot be set without a plan'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END IF;

      SELECT owner_account_id, is_predefined
      INTO plan_owner, plan_is_predefined
      FROM user_plans WHERE id = NEW.user_plan_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'User plan % does not exist', NEW.user_plan_id
          USING ERRCODE = '23503';
      END IF;
      IF plan_is_predefined AND plan_owner IS NOT NULL THEN
        RAISE EXCEPTION 'Predefined user plans must not have an owner account'
          USING ERRCODE = '23514';
      END IF;
      IF plan_owner IS NOT NULL AND plan_owner <> NEW.account_id THEN
        RAISE EXCEPTION 'Custom user plans can only be assigned within their owner account'
          USING ERRCODE = '23514';
      END IF;

      IF TG_OP = 'INSERT' OR NEW.user_plan_id IS DISTINCT FROM OLD.user_plan_id THEN
        NEW.user_plan_owner_account_id := plan_owner;
      ELSIF NEW.user_plan_owner_account_id IS DISTINCT FROM plan_owner THEN
        RAISE EXCEPTION 'User plan owner does not match the selected plan'
          USING ERRCODE = '23514';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE FUNCTION prevent_plan_ownership_change() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.owner_account_id IS DISTINCT FROM OLD.owner_account_id
        OR NEW.is_predefined IS DISTINCT FROM OLD.is_predefined THEN
        RAISE EXCEPTION 'Plan ownership and predefined scope cannot be changed after creation'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER account_plans_ownership_immutable_trigger
      BEFORE UPDATE OF owner_account_id, is_predefined ON account_plans
      FOR EACH ROW EXECUTE FUNCTION prevent_plan_ownership_change();

    CREATE TRIGGER user_plans_ownership_immutable_trigger
      BEFORE UPDATE OF owner_account_id, is_predefined ON user_plans
      FOR EACH ROW EXECUTE FUNCTION prevent_plan_ownership_change();
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS user_plans_ownership_immutable_trigger ON user_plans;
    DROP TRIGGER IF EXISTS account_plans_ownership_immutable_trigger ON account_plans;
    DROP FUNCTION IF EXISTS prevent_plan_ownership_change();
  `);
};
