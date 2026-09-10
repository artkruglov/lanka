-- Corporate resources only. Local owner UUIDs without a corporate principal are untouched.
CREATE TABLE lanka.resource_nodes (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id) ON DELETE CASCADE,
 id uuid NOT NULL DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('folder','material')),
 owner_id uuid NOT NULL, material_id uuid, folder_id uuid,
 parent_folder_id uuid, parent_kind text NOT NULL DEFAULT 'folder' CHECK(parent_kind='folder'),
 inheritance text NOT NULL DEFAULT 'restricted' CHECK(inheritance IN ('inherit','restricted')),
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,id,kind),
 UNIQUE(tenant_id,material_id), UNIQUE(tenant_id,owner_id,folder_id),
 FOREIGN KEY(tenant_id,owner_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,material_id,owner_id) REFERENCES lanka.materials(tenant_id,id,owner_id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,owner_id,folder_id) REFERENCES lanka.catalog_folders(tenant_id,owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,parent_folder_id,parent_kind) REFERENCES lanka.resource_nodes(tenant_id,id,kind) ON DELETE CASCADE,
 CHECK((kind='folder' AND folder_id IS NOT NULL AND material_id IS NULL) OR (kind='material' AND material_id IS NOT NULL AND folder_id IS NULL)),
 CHECK(parent_folder_id IS DISTINCT FROM id)
);
CREATE INDEX resource_parent ON lanka.resource_nodes(tenant_id,parent_folder_id,id) WHERE deleted_at IS NULL;
CREATE TABLE lanka.folder_closure (
 tenant_id uuid NOT NULL, ancestor_id uuid NOT NULL, descendant_id uuid NOT NULL, depth integer NOT NULL CHECK(depth BETWEEN 0 AND 64),
 node_kind text NOT NULL DEFAULT 'folder' CHECK(node_kind='folder'),
 PRIMARY KEY(tenant_id,ancestor_id,descendant_id),
 FOREIGN KEY(tenant_id,ancestor_id,node_kind) REFERENCES lanka.resource_nodes(tenant_id,id,kind) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,descendant_id,node_kind) REFERENCES lanka.resource_nodes(tenant_id,id,kind) ON DELETE CASCADE,
 CHECK((depth=0)=(ancestor_id=descendant_id))
);
CREATE INDEX folder_descendant ON lanka.folder_closure(tenant_id,descendant_id,depth);
CREATE TABLE lanka.groups (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id) ON DELETE CASCADE, id uuid NOT NULL,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 180), status text NOT NULL CHECK(status IN ('active','suspended')),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE lanka.group_members (
 tenant_id uuid NOT NULL, group_id uuid NOT NULL, principal_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,group_id,principal_id),
 FOREIGN KEY(tenant_id,group_id) REFERENCES lanka.groups(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX group_member_principal ON lanka.group_members(tenant_id,principal_id,group_id);
CREATE TABLE lanka.acl_grants (
 tenant_id uuid NOT NULL, resource_id uuid NOT NULL, principal_id uuid, group_id uuid,
 role text NOT NULL CHECK(role IN ('viewer','commenter','editor','manager')), can_copy boolean NOT NULL DEFAULT false,
 CHECK((principal_id IS NULL)<>(group_id IS NULL)),
 FOREIGN KEY(tenant_id,resource_id) REFERENCES lanka.resource_nodes(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,principal_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE,
 FOREIGN KEY(tenant_id,group_id) REFERENCES lanka.groups(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX acl_principal ON lanka.acl_grants(tenant_id,resource_id,principal_id) WHERE principal_id IS NOT NULL;
CREATE UNIQUE INDEX acl_group ON lanka.acl_grants(tenant_id,resource_id,group_id) WHERE group_id IS NOT NULL;
CREATE INDEX acl_subject ON lanka.acl_grants(tenant_id,principal_id,resource_id);
CREATE INDEX acl_group_subject ON lanka.acl_grants(tenant_id,group_id,resource_id);
CREATE TABLE lanka.resource_receipts (
 tenant_id uuid NOT NULL, actor_id uuid NOT NULL, request_id uuid NOT NULL, fingerprint text NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,request_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE lanka.resource_audit (
 tenant_id uuid NOT NULL REFERENCES lanka.tenants(id) ON DELETE CASCADE, sequence bigint NOT NULL,
 actor_id uuid NOT NULL, action text NOT NULL, resource_id uuid, metadata jsonb NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,sequence),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES lanka.principals(tenant_id,id) ON DELETE CASCADE
);
-- Retain old catalogue IDs. Node IDs are independent: folder IDs may coincide across authors.
INSERT INTO lanka.resource_nodes(tenant_id,owner_id,kind,folder_id)
 SELECT f.tenant_id,f.owner_id,'folder',f.id FROM lanka.catalog_folders f JOIN lanka.principals p ON p.tenant_id=f.tenant_id AND p.id=f.owner_id;
INSERT INTO lanka.folder_closure(tenant_id,ancestor_id,descendant_id,depth)
 SELECT tenant_id,id,id,0 FROM lanka.resource_nodes WHERE kind='folder';
INSERT INTO lanka.resource_nodes(tenant_id,owner_id,kind,material_id,parent_folder_id,deleted_at)
 SELECT m.tenant_id,m.owner_id,'material',m.id,f.id,CASE WHEN m.trashed THEN now() END
 FROM lanka.materials m JOIN lanka.principals p ON p.tenant_id=m.tenant_id AND p.id=m.owner_id
 LEFT JOIN lanka.resource_nodes f ON f.tenant_id=m.tenant_id AND f.owner_id=m.owner_id AND f.folder_id=m.folder_id;

CREATE FUNCTION lanka.catalog_resource_node() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node_id uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM lanka.principals WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id) THEN
  INSERT INTO lanka.resource_nodes(tenant_id,owner_id,kind,folder_id) VALUES(NEW.tenant_id,NEW.owner_id,'folder',NEW.id) RETURNING id INTO node_id;
  INSERT INTO lanka.folder_closure(tenant_id,ancestor_id,descendant_id,depth) VALUES(NEW.tenant_id,node_id,node_id,0);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER catalog_resource_insert AFTER INSERT ON lanka.catalog_folders FOR EACH ROW EXECUTE FUNCTION lanka.catalog_resource_node();
CREATE FUNCTION lanka.material_resource_node() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_id uuid;
BEGIN
 IF EXISTS(SELECT 1 FROM lanka.principals WHERE tenant_id=NEW.tenant_id AND id=NEW.owner_id) THEN
  SELECT id INTO parent_id FROM lanka.resource_nodes WHERE tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND folder_id=NEW.folder_id;
  IF TG_OP='INSERT' THEN
   INSERT INTO lanka.resource_nodes(tenant_id,owner_id,kind,material_id,parent_folder_id,deleted_at)
    VALUES(NEW.tenant_id,NEW.owner_id,'material',NEW.id,parent_id,CASE WHEN NEW.trashed THEN now() END);
  ELSE
   IF OLD.folder_id IS DISTINCT FROM NEW.folder_id THEN
    UPDATE lanka.resource_nodes SET parent_folder_id=parent_id WHERE tenant_id=NEW.tenant_id AND material_id=NEW.id;
   END IF;
   IF OLD.trashed IS DISTINCT FROM NEW.trashed THEN
    UPDATE lanka.resource_nodes SET deleted_at=CASE WHEN NEW.trashed THEN now() END WHERE tenant_id=NEW.tenant_id AND material_id=NEW.id;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER material_resource_insert AFTER INSERT ON lanka.materials FOR EACH ROW EXECUTE FUNCTION lanka.material_resource_node();
CREATE TRIGGER material_resource_update AFTER UPDATE OF folder_id,trashed ON lanka.materials FOR EACH ROW EXECUTE FUNCTION lanka.material_resource_node();
