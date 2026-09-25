"""Flask server for Semester Planner. Student data is public; writes require admin login."""
import functools
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import time
from datetime import timedelta
from pathlib import Path

import click
from flask import Flask, Request, current_app, abort, flash, g, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.middleware.proxy_fix import ProxyFix
from dataset import InvalidDataset, parse_json, summary, validate_dataset

BASE = Path(__file__).resolve().parent


class PlannerRequest(Request):
    # Flask 3.0 does not read MAX_FORM_MEMORY_SIZE from app configuration.
    @property
    def max_form_memory_size(self):
        return current_app.config['MAX_FORM_MEMORY_SIZE']


def create_app(test_config=None):
    app = Flask(__name__, instance_path=os.environ.get('PLANNER_INSTANCE', str(BASE / 'instance')))
    app.request_class = PlannerRequest
    app.config.update(
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
        MAX_FORM_MEMORY_SIZE=2 * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
        SESSION_COOKIE_SECURE=os.environ.get('APP_ENV', 'production') != 'development',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=2),
        SESSION_REFRESH_EACH_REQUEST=False,
        DATABASE=str(Path(app.instance_path) / 'planner.sqlite3'),
    )
    if test_config:
        app.config.update(test_config)
    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    secret_path = Path(app.instance_path) / 'secret.key'
    if not app.config.get('SECRET_KEY'):
        env_secret = os.environ.get('SECRET_KEY')
        if env_secret:
            if len(env_secret) < 32:
                raise RuntimeError('SECRET_KEY must contain at least 32 characters.')
            app.config['SECRET_KEY'] = env_secret
        else:
            # Created once, never replaced on restart. Shared instance volume is required.
            try:
                fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                    handle.write(secrets.token_hex(32))
            except FileExistsError:
                pass
            app.config['SECRET_KEY'] = secret_path.read_text(encoding='utf-8').strip()
            if len(app.config['SECRET_KEY']) < 32:
                raise RuntimeError('The persistent secret.key is invalid.')
    if os.environ.get('TRUST_PROXY') == '1':
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)
    build_files = [BASE / 'static/theme.js', BASE / 'templates/index.html', BASE / 'static/app.js', BASE / 'static/app.css', BASE / 'static/sw.js', BASE / 'static/icon.svg', BASE / 'static/icon-192.png', BASE / 'static/icon-512.png', BASE / 'static/apple-touch-icon.png', BASE / 'app.py']
    app.config['BUILD_ID'] = hashlib.sha256(b''.join(p.read_bytes() for p in build_files)).hexdigest()[:16]

    def db():
        if 'db' not in g:
            g.db = sqlite3.connect(app.config['DATABASE'], timeout=15)
            g.db.row_factory = sqlite3.Row
            g.db.execute('PRAGMA journal_mode=WAL')
        return g.db

    @app.teardown_appcontext
    def close_db(error=None):
        connection = g.pop('db', None)
        if connection:
            connection.close()

    with app.app_context():
        db().executescript('''
            CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, created REAL NOT NULL, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS drafts (token TEXT PRIMARY KEY, created REAL NOT NULL, base_revision INTEGER NOT NULL, document TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS attempts (address TEXT NOT NULL, created REAL NOT NULL);
            CREATE INDEX IF NOT EXISTS attempts_address ON attempts(address, created);
        ''')
        if not db().execute('SELECT id FROM versions LIMIT 1').fetchone():
            data = validate_dataset(parse_json((BASE / 'data/semester-5.json').read_text(encoding='utf-8')))
            db().execute('INSERT INTO versions(created, document) VALUES (?, ?)', (time.time(), json.dumps(data)))
        db().commit()

    def live():
        return db().execute('SELECT * FROM versions ORDER BY id DESC LIMIT 1').fetchone()

    def admin_hash():
        row = db().execute("SELECT value FROM settings WHERE key='admin_hash'").fetchone()
        return os.environ.get('ADMIN_PASSWORD_HASH') or (row['value'] if row else '')

    def password_version():
        return hashlib.sha256(admin_hash().encode()).hexdigest()

    def authenticated():
        return bool(admin_hash()) and session.get('admin') is True and hmac.compare_digest(session.get('password_version', ''), password_version())

    def csrf():
        if 'csrf' not in session:
            session['csrf'] = secrets.token_urlsafe(32)
        return session['csrf']

    app.jinja_env.globals['csrf_token'] = csrf

    def require_admin(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            if not authenticated():
                return redirect(url_for('login'))
            return fn(*args, **kwargs)
        return wrapped

    @app.before_request
    def protect_mutations():
        if request.method == 'POST':
            token = request.form.get('csrf', '')
            if not token or not hmac.compare_digest(token, session.get('csrf', '')):
                abort(400, 'Your form expired. Reload the page and try again.')

    @app.after_request
    def response_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        response.headers['Cache-Control'] = 'no-store'
        if request.is_secure:
            response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        return response

    @app.get('/')
    @app.get('/semester-one.html')
    def index():
        return render_template('index.html', build=app.config['BUILD_ID'])

    @app.get('/api/dataset')
    def dataset():
        row = live()
        return jsonify(revision=row['id'], updated_at=row['created'], build=app.config['BUILD_ID'], data=json.loads(row['document']))

    @app.get('/api/version')
    def version():
        return jsonify(revision=live()['id'], build=app.config['BUILD_ID'])

    @app.get('/sw.js')
    def service_worker():
        content = (BASE / 'static/sw.js').read_text(encoding='utf-8').replace('__BUILD__', app.config['BUILD_ID'])
        return app.response_class(content, mimetype='application/javascript', headers={'Service-Worker-Allowed': '/'})

    @app.get('/manifest.webmanifest')
    def manifest():
        return jsonify(name='Semester Planner', short_name='Semester', id='/', start_url='/', scope='/', display='standalone', background_color='#f6f7f9', theme_color='#f6f7f9', icons=[{'src':'/static/icon-192.png','sizes':'192x192','type':'image/png'}, {'src':'/static/icon-512.png','sizes':'512x512','type':'image/png','purpose':'any maskable'}])

    @app.route('/admin/login', methods=['GET', 'POST'])
    def login():
        if not admin_hash():
            return render_template('login.html', setup_required=True), 503
        if authenticated():
            return redirect(url_for('admin'))
        error = None
        if request.method == 'POST':
            address = request.remote_addr or 'unknown'
            cutoff = time.time() - 900
            db().execute('DELETE FROM attempts WHERE created < ?', (cutoff,))
            if db().execute('SELECT COUNT(*) FROM attempts WHERE address=?', (address,)).fetchone()[0] >= 10:
                db().commit()
                return render_template('login.html', error='Too many attempts. Try again in 15 minutes.'), 429
            password = request.form.get('password', '')
            if len(password) <= 1024 and check_password_hash(admin_hash(), password):
                db().execute('DELETE FROM attempts WHERE address=?', (address,))
                db().commit()
                session.clear()
                session.permanent = True
                session['admin'] = True
                session['password_version'] = password_version()
                csrf()
                return redirect(url_for('admin'))
            db().execute('INSERT INTO attempts VALUES (?, ?)', (address, time.time()))
            db().commit()
            error = 'Incorrect password.'
        return render_template('login.html', error=error)

    @app.get('/admin')
    @require_admin
    def admin():
        row = live()
        history = db().execute('SELECT id, created FROM versions ORDER BY id DESC LIMIT 20').fetchall()
        return render_template('admin.html', current=summary(json.loads(row['document'])), revision=row['id'], history=history)

    @app.post('/admin/preview')
    @require_admin
    def preview():
        upload = request.files.get('file')
        try:
            raw = upload.read().decode('utf-8-sig') if upload and upload.filename else request.form.get('document', '')
            data = validate_dataset(parse_json(raw))
        except (InvalidDataset, UnicodeError) as exc:
            flash(str(exc), 'error')
            return redirect(url_for('admin'))
        token = secrets.token_urlsafe(32)
        db().execute('DELETE FROM drafts WHERE created < ?', (time.time() - 3600,))
        db().execute('INSERT INTO drafts VALUES (?, ?, ?, ?)', (token, time.time(), live()['id'], json.dumps(data)))
        db().commit()
        return render_template('preview.html', token=token, semesters=summary(data), active=data['active_semester_id'], shared=len(data['calendar_events']))

    @app.post('/admin/publish')
    @require_admin
    def publish():
        db().execute('BEGIN IMMEDIATE')
        draft = db().execute('SELECT * FROM drafts WHERE token=?', (request.form.get('token', ''),)).fetchone()
        if not draft or draft['created'] < time.time() - 3600:
            db().rollback()
            abort(400, 'Import preview expired. Upload it again.')
        if draft['base_revision'] != live()['id']:
            db().rollback()
            abort(409, 'The live data changed since this preview. Upload again to review the latest version.')
        data = validate_dataset(parse_json(draft['document']))
        db().execute('INSERT INTO versions(created, document) VALUES (?, ?)', (time.time(), json.dumps(data)))
        db().execute('DELETE FROM drafts WHERE token=?', (draft['token'],))
        db().commit()
        flash('Published. Student devices will receive this update when they next open or reconnect.', 'success')
        return redirect(url_for('admin'))

    @app.post('/admin/restore/<int:revision>')
    @require_admin
    def restore(revision):
        row = db().execute('SELECT document FROM versions WHERE id=?', (revision,)).fetchone()
        if not row:
            abort(404)
        data = validate_dataset(parse_json(row['document']))
        token = secrets.token_urlsafe(32)
        db().execute('INSERT INTO drafts VALUES (?, ?, ?, ?)', (token, time.time(), live()['id'], json.dumps(data)))
        db().commit()
        return render_template('preview.html', token=token, semesters=summary(data), active=data['active_semester_id'], shared=len(data['calendar_events']), restoring=revision)

    @app.get('/admin/export')
    @require_admin
    def export():
        return app.response_class(json.dumps(json.loads(live()['document']), indent=2), mimetype='application/json', headers={'Content-Disposition':'attachment; filename="semester-planner.json"'})

    @app.get('/admin/schema')
    @require_admin
    def schema():
        return app.response_class((BASE / 'schema.json').read_text(encoding='utf-8'), mimetype='application/json', headers={'Content-Disposition':'attachment; filename="semester-planner-schema.json"'})

    @app.post('/admin/logout')
    def logout():
        session.clear()
        return redirect(url_for('login'))

    @app.cli.command('set-admin-password')
    @click.password_option(confirmation_prompt=True)
    def set_password(password):
        """Set or change the administrator password. Existing sessions become invalid."""
        if len(password) < 12 or len(password) > 1024:
            raise click.ClickException('Use a password between 12 and 1024 characters.')
        if os.environ.get('ADMIN_PASSWORD_HASH'):
            raise click.ClickException('ADMIN_PASSWORD_HASH is set in the environment. Update or remove it first.')
        db().execute("INSERT OR REPLACE INTO settings VALUES ('admin_hash', ?)", (generate_password_hash(password),))
        db().commit()
        click.echo('Administrator password saved securely.')

    @app.cli.command('validate-import')
    @click.argument('filename', type=click.Path(exists=True))
    def validate_import(filename):
        """Validate a future semester import without changing the live data."""
        try:
            data = validate_dataset(parse_json(Path(filename).read_text(encoding='utf-8-sig')))
        except (InvalidDataset, UnicodeError) as exc:
            raise click.ClickException(str(exc)) from exc
        click.echo(f'Valid: {len(data["semesters"])} semester(s). Active: {data["active_semester_id"]}')

    return app
