import {pgTable,text,integer,jsonb,primaryKey,boolean,timestamp} from 'drizzle-orm/pg-core';
import {drizzle} from 'drizzle-orm/node-postgres';
import pg from 'pg';
export const tenants=pgTable('tenants',{id:text('id').primaryKey(),name:text('name').notNull(),displayName:text('display_name'),active:boolean('active').notNull().default(true),bundleVersion:integer('bundle_version').notNull().default(0)});
export const agents=pgTable('agents',{tenantId:text('tenant_id').notNull().references(()=>tenants.id),id:text('id').notNull(),active:boolean('active').notNull().default(true)},t=>[primaryKey({columns:[t.tenantId,t.id]})]);
export const policies=pgTable('policies',{tenantId:text('tenant_id').notNull().references(()=>tenants.id),agentId:text('agent_id').notNull(),version:integer('version').notNull(),active:boolean('active').notNull().default(true),body:jsonb('body').notNull()},t=>[primaryKey({columns:[t.tenantId,t.agentId]})]);
export const revocations=pgTable('revocations',{tenantId:text('tenant_id').notNull().references(()=>tenants.id),jti:text('jti').notNull(),expiresAt:timestamp('expires_at',{withTimezone:true}).notNull()},t=>[primaryKey({columns:[t.tenantId,t.jti]})]);
export const telemetry=pgTable('telemetry',{tenantId:text('tenant_id').notNull().references(()=>tenants.id),deploymentId:text('deployment_id').notNull(),windowStart:timestamp('window_start',{withTimezone:true}).notNull(),body:jsonb('body').notNull()},t=>[primaryKey({columns:[t.tenantId,t.deploymentId,t.windowStart]})]);
export function database(url:string){const pool=new pg.Pool({connectionString:url,max:10});return {pool,db:drizzle(pool)};}
