from __future__ import annotations
import json
from datetime import datetime, timezone
from uuid import uuid4
from app.errors import AppError


class DynamicRepository:
    def __init__(self, database):
        self.database = database
        with database.connection() as db:
            db.executescript("""
            CREATE TABLE IF NOT EXISTS dynamic_sessions (
                token TEXT PRIMARY KEY REFERENCES sessions(token),
                state_version INTEGER NOT NULL DEFAULT 1, state_payload TEXT NOT NULL DEFAULT '{}',
                position_revision INTEGER NOT NULL DEFAULT 0, position_payload TEXT);
            CREATE TABLE IF NOT EXISTS route_proposals (
                proposal_id TEXT PRIMARY KEY, token TEXT NOT NULL REFERENCES sessions(token),
                route_id TEXT NOT NULL REFERENCES routes(route_id), base_revision INTEGER NOT NULL,
                state_version INTEGER NOT NULL, position_revision INTEGER NOT NULL,
                expires_at TEXT NOT NULL, payload TEXT NOT NULL, accepted_revision INTEGER);
            """)

    def snapshot(self, token):
        self.database.session(token)
        with self.database.connection() as db:
            db.execute('INSERT OR IGNORE INTO dynamic_sessions(token) VALUES (?)', (token,))
            row = db.execute('SELECT * FROM dynamic_sessions WHERE token=?', (token,)).fetchone()
        return {'state_version':row['state_version'], 'states':json.loads(row['state_payload']),
                'position_revision':row['position_revision'],
                'position':json.loads(row['position_payload']) if row['position_payload'] else None}

    def update_position(self, token, payload):
        self.snapshot(token)
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT position_payload FROM dynamic_sessions WHERE token=?',(token,)).fetchone()
            if row[0]:
                old=json.loads(row[0])
                if datetime.fromisoformat(old['observed_at']) > datetime.fromisoformat(payload['observed_at']):
                    raise AppError('STALE_POSITION','位置时间早于已保存位置。',409)
            db.execute('UPDATE dynamic_sessions SET position_revision=position_revision+1,position_payload=? WHERE token=?',
                       (json.dumps(payload,ensure_ascii=False),token))
        return self.snapshot(token)

    def update_state(self, token, event):
        self.snapshot(token)
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT state_version,state_payload FROM dynamic_sessions WHERE token=?',(token,)).fetchone()
            if row[0]!=event.base_state_version:
                raise AppError('STALE_STATE','商家状态版本已变化。',409)
            states=json.loads(row[1])
            entry=states.setdefault(event.place_id,{})
            entry.update(event.model_dump(exclude_none=True,exclude={'base_state_version','place_id'}))
            entry['updated_at']=datetime.now(timezone.utc).isoformat()
            db.execute('UPDATE dynamic_sessions SET state_version=state_version+1,state_payload=? WHERE token=?',
                       (json.dumps(states,ensure_ascii=False),token))
        return self.snapshot(token)

    def commit_route(self, token, route, base_revision):
        payload=json.dumps(route,ensure_ascii=False)
        with self.database.connection() as db:
            changed=db.execute('UPDATE routes SET revision=?,payload=? WHERE route_id=? AND token=? AND revision=?',
                  (route['revision'],payload,route['route_id'],token,base_revision)).rowcount
            if changed!=1:raise AppError('STALE_REVISION','行程版本已变化，请重新读取。',409)
            db.execute('INSERT INTO route_revisions VALUES (?,?,?)',(route['route_id'],route['revision'],payload))
        return self.database.route(token,route['route_id'])

    def save_proposal(self, token, route, snapshot, expires_at, payload):
        proposal_id='proposal_'+uuid4().hex
        data={**payload,'proposal_id':proposal_id,'route_id':route['route_id'],
              'base_revision':route['revision'],'state_version':snapshot['state_version'],
              'position_revision':snapshot['position_revision'],'expires_at':expires_at}
        with self.database.connection() as db:
            db.execute('INSERT INTO route_proposals VALUES (?,?,?,?,?,?,?,?,NULL)',
               (proposal_id,token,route['route_id'],route['revision'],snapshot['state_version'],
                snapshot['position_revision'],expires_at,json.dumps(data,ensure_ascii=False)))
        return data

    def accept(self, token, route_id, body):
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT * FROM route_proposals WHERE proposal_id=? AND token=? AND route_id=?',
                           (body.proposal_id,token,route_id)).fetchone()
            current=db.execute('SELECT revision,payload FROM routes WHERE route_id=? AND token=?',(route_id,token)).fetchone()
            if row is None or current is None:raise AppError('RESOURCE_NOT_FOUND','建议不存在。',404)
            if body.base_revision!=row['base_revision']:
                raise AppError('STALE_REVISION','提交版本不匹配建议。',409)
            if row['accepted_revision'] is not None:
                return json.loads(current['payload'])
            state=db.execute('SELECT state_version,position_revision FROM dynamic_sessions WHERE token=?',(token,)).fetchone()
            if (current['revision']!=row['base_revision'] or state is None or state[0]!=row['state_version']
                    or state[1]!=row['position_revision']
                    or datetime.now(timezone.utc)>datetime.fromisoformat(row['expires_at'])):
                raise AppError('STALE_PROPOSAL','路线、商家状态或用户位置已变化，或建议过期，请重新计算。',409)
            proposal=json.loads(row['payload'])
            if hasattr(self,'catalog_version') and proposal.get('catalog_version')!=self.catalog_version():
                raise AppError('STALE_PROPOSAL','地点目录已更新，请重新计算路线。',409)
            origin=proposal.get('render',{}).get('origin') or {}
            if origin.get('observed_at') and (datetime.now(timezone.utc)-datetime.fromisoformat(origin['observed_at'])).total_seconds()>120:
                raise AppError('STALE_POSITION','建议所用位置已过期，请刷新定位后重排。',409)
            route=proposal['route']
            route.update(route_id=route_id,revision=current['revision']+1,state_version=row['state_version'])
            route['last_accepted_proposal_id']=body.proposal_id
            payload=json.dumps(route,ensure_ascii=False)
            db.execute('UPDATE routes SET revision=?,payload=? WHERE route_id=? AND token=?',
                       (route['revision'],payload,route_id,token))
            db.execute('INSERT INTO route_revisions VALUES (?,?,?)',(route_id,route['revision'],payload))
            db.execute('UPDATE route_proposals SET accepted_revision=? WHERE proposal_id=?',(route['revision'],body.proposal_id))
        return self.database.route(token,route_id)
