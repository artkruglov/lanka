-- One persisted conversation can precede document creation and reference multiple materials.
ALTER TABLE lanka.agent_sessions ALTER COLUMN material_id DROP NOT NULL;
ALTER TABLE lanka.agent_sessions ADD COLUMN scope_kind text NOT NULL DEFAULT 'material'
 CHECK(scope_kind IN ('material','workspace','folder'));
ALTER TABLE lanka.agent_sessions ADD COLUMN folder_resource_id uuid;
ALTER TABLE lanka.agent_sessions ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE lanka.agent_sessions ADD COLUMN creation_fingerprint text;
ALTER TABLE lanka.agent_sessions ADD FOREIGN KEY(tenant_id,folder_resource_id)
 REFERENCES lanka.resource_nodes(tenant_id,id);
ALTER TABLE lanka.agent_sessions ADD CONSTRAINT agent_sessions_scope_check CHECK(
 (scope_kind='material' AND material_id IS NOT NULL AND folder_resource_id IS NULL) OR
 (scope_kind='workspace' AND material_id IS NULL AND folder_resource_id IS NULL) OR
 (scope_kind='folder' AND material_id IS NULL AND folder_resource_id IS NOT NULL)
);
CREATE TABLE lanka.agent_session_materials (
 tenant_id uuid NOT NULL,session_id uuid NOT NULL,material_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,session_id,material_id),
 FOREIGN KEY(tenant_id,session_id) REFERENCES lanka.agent_sessions(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,material_id) REFERENCES lanka.materials(tenant_id,id) ON DELETE CASCADE
);
INSERT INTO lanka.agent_session_materials(tenant_id,session_id,material_id)
 SELECT tenant_id,id,material_id FROM lanka.agent_sessions WHERE material_id IS NOT NULL;
CREATE FUNCTION lanka.link_material_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.material_id IS NOT NULL THEN
  INSERT INTO lanka.agent_session_materials(tenant_id,session_id,material_id)
   VALUES(NEW.tenant_id,NEW.id,NEW.material_id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER agent_session_material_link AFTER INSERT OR UPDATE OF material_id ON lanka.agent_sessions
 FOR EACH ROW EXECUTE FUNCTION lanka.link_material_session();
ALTER TABLE lanka.agent_runs DROP CONSTRAINT agent_runs_tenant_id_session_id_material_id_fkey;
ALTER TABLE lanka.agent_runs ADD FOREIGN KEY(tenant_id,session_id,material_id)
 REFERENCES lanka.agent_session_materials(tenant_id,session_id,material_id);
CREATE INDEX agent_sessions_owner_scope ON lanka.agent_sessions(tenant_id,owner_id,scope_kind,updated_at DESC,id);
