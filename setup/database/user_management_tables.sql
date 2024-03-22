-- DDL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

drop table tbl_mst_role_attribute;
drop table tbl_mst_user_attribute;
drop table tbl_trx_user_role;
drop table tbl_mst_role;
drop table tbl_mst_user;

delete from tbl_mst_role_attribute;
delete from tbl_mst_user_attribute;
delete from tbl_trx_user_role;
delete from tbl_mst_role;
delete from tbl_mst_user;

-- Create tbl_mst_user table
CREATE TABLE "tbl_mst_user" (
    user_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    identifier VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP
);

-- Create tbl_mst_role table
CREATE TABLE "tbl_mst_role" (
    role_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create tbl_trx_user_role table
CREATE TABLE "tbl_trx_user_role" (
    user_role_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    role_id UUID NOT NULL,
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, role_id),
    FOREIGN KEY (user_id) REFERENCES "tbl_mst_user" (user_id) ON DELETE CASCADE,
    FOREIGN KEY (role_id) REFERENCES "tbl_mst_role" (role_id) ON DELETE CASCADE
);

-- Create tbl_mst_user_attribute table
CREATE TABLE "tbl_mst_user_attribute" (
    user_attribute_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    attribute_name VARCHAR[] NOT null default ARRAY[]::character varying[],
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES "tbl_mst_user" (user_id) ON DELETE CASCADE
);

-- Create tbl_mst_role_attribute table
CREATE TABLE "tbl_mst_role_attribute" (
    role_attribute_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    role_id UUID NOT NULL,
    app_name VARCHAR(255) NOT NULL,
    attribute_name VARCHAR[] NOT null default ARRAY[]::character varying[],
    created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES "tbl_mst_role" (role_id) ON DELETE CASCADE
);

-- DML
-- insert into tbl_mst_user(identifier, password)
-- values('wildananugrah', 'p@ssw0rd') returning *;

-- insert into tbl_mst_role(role_name)
-- values('admin');

-- insert into tbl_mst_role_attribute(role_id, app_name, attribute_name)
-- values ('a43f40ba-1422-486d-92cf-4616c1a19a1d','test_app', '{"READ", "WRITE"}');
-- insert into tbl_mst_role_attribute(role_id, app_name, attribute_name)
-- values ('a43f40ba-1422-486d-92cf-4616c1a19a1d','test_app2', '{"READ", "WRITE"}');

-- insert into tbl_trx_user_role (user_id , role_id)
-- values('5d1ea8ad-9ffa-4ebb-8abd-d908941c79d2','a43f40ba-1422-486d-92cf-4616c1a19a1d');

-- insert into tbl_mst_user_attribute (user_id, app_name, attribute_name)
-- values ('5d1ea8ad-9ffa-4ebb-8abd-d908941c79d2', 'test_app3', '{"READ"}');

select * from (select 
	tmra.role_attribute_id, 
	tmra.app_name, 
	tmra.attribute_name,
	tmra.created_at,
	tmu.user_id
from tbl_trx_user_role ttur
join tbl_mst_role tmr on ttur.role_id = tmr.role_id
join tbl_mst_role_attribute tmra on tmra.role_id  = tmr.role_id 
join tbl_mst_user tmu on ttur.user_id = tmu.user_id
union
select 
	tmua.user_attribute_id, 
	tmua.app_name, 
	tmua.attribute_name, 
	tmua.created_at,
	tmu.user_id
from tbl_mst_user_attribute tmua
join tbl_mst_user tmu on tmu.user_id = tmua.user_id) as a 
where a.user_id=(select user_id from tbl_mst_user tmu where identifier='wildananugrah')
order by a.created_at asc;

select * from tbl_mst_role tmr ;
select * from tbl_mst_role_attribute;
select * from tbl_mst_user tmu ;
select * from tbl_mst_user_attribute tmua ;
select * from tbl_trx_user_role ttur ;
select * from tbl_mst_user tmu ;
delete from tbl_mst_user ;