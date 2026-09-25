import copy
import io
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from app import create_app
from dataset import InvalidDataset, validate_dataset, parse_json

BASE = Path(__file__).resolve().parents[1]


class ServerTests(unittest.TestCase):
    def setUp(self):
        # PLANNER_TEST_TMP can keep test files inside a sandbox workspace.
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('PLANNER_TEST_TMP'))
        os.environ['PLANNER_INSTANCE'] = self.temp.name
        self.app = create_app({'TESTING': True, 'DATABASE': self.temp.name + '/test.sqlite3', 'SECRET_KEY': 'test-secret-not-for-deployment', 'SESSION_COOKIE_SECURE': False})
        self.client = self.app.test_client()
        result = self.app.test_cli_runner().invoke(args=['set-admin-password', '--password', 'test-only-password-12345'])
        self.assertEqual(result.exit_code, 0, result.output)
        self.data = json.loads((BASE / 'data/semester-5.json').read_text())

    def tearDown(self):
        if os.environ.get('PLANNER_TEST_TMP'):
            self.assertEqual(Path(self.temp.name).resolve().parent, Path(os.environ['PLANNER_TEST_TMP']).resolve())
        self.temp.cleanup()

    def csrf(self, response):
        return re.search(r'name="csrf" value="([^"]+)"', response.get_data(as_text=True)).group(1)

    def login(self):
        token = self.csrf(self.client.get('/admin/login'))
        response = self.client.post('/admin/login', data={'csrf': token, 'password': 'test-only-password-12345'})
        self.assertEqual(response.status_code, 302)
        return self.csrf(self.client.get('/admin'))

    def preview(self, data, token):
        return self.client.post('/admin/preview', data={'csrf': token, 'document': json.dumps(data)})

    def test_large_admin_form_on_flask_30(self):
        token = self.login()
        # Valid import above Werkzeug 3.0's default 500 KB form limit.
        document = ' ' * 600000 + json.dumps(self.data)
        response = self.client.post('/admin/preview', data={'csrf': token, 'document': document}, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 200)
        response = self.client.post('/admin/preview', data={'csrf': token, 'document': ' ' * (2 * 1024 * 1024)}, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 413)

    def test_public_read_and_protected_writes(self):
        self.assertEqual(self.client.get('/api/dataset').json['data']['semesters'][0]['title'], 'Semester 5')
        self.assertEqual(self.client.get('/admin/export').status_code, 302)
        self.assertEqual(self.client.post('/admin/publish').status_code, 400)
        token = self.csrf(self.client.get('/admin/login'))
        self.assertEqual(self.client.post('/admin/publish', data={'csrf': token}).status_code, 302)
        for path in ['/', '/api/dataset', '/api/version', '/sw.js', '/admin/login']:
            response = self.client.get(path)
            self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(response.headers['X-Frame-Options'], 'DENY')

    def test_publish_revision_and_restore(self):
        csrf = self.login()
        original = self.client.get('/api/dataset').json
        self.data['semesters'][0]['title'] = 'Semester 5 updated'
        preview = self.preview(self.data, csrf)
        self.assertEqual(preview.status_code, 200)
        self.assertEqual(self.client.get('/api/dataset').json['revision'], original['revision'])
        token = re.search(r'name="token" value="([^"]+)"', preview.get_data(as_text=True)).group(1)
        self.assertEqual(self.client.post('/admin/publish', data={'csrf': csrf, 'token': token}).status_code, 302)
        updated = self.client.get('/api/dataset').json
        self.assertGreater(updated['revision'], original['revision'])
        self.assertEqual(updated['data']['semesters'][0]['title'], 'Semester 5 updated')
        restore = self.client.post('/admin/restore/1', data={'csrf': csrf})
        token = re.search(r'name="token" value="([^"]+)"', restore.get_data(as_text=True)).group(1)
        self.client.post('/admin/publish', data={'csrf': csrf, 'token': token})
        self.assertEqual(self.client.get('/api/dataset').json['data'], original['data'])

    def test_invalid_import_does_not_touch_live_data(self):
        csrf = self.login()
        before = self.client.get('/api/dataset').json
        self.data['semesters'][0]['sessions'][0]['course_id'] = 'missing-course'
        response = self.preview(self.data, csrf)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.get('/api/dataset').json, before)
        response = self.client.post('/admin/preview', data={'csrf': csrf, 'file': (io.BytesIO(b'\xff\xff'), 'bad.json')}, content_type='multipart/form-data')
        self.assertEqual(response.status_code, 302)

    def test_stale_preview_is_rejected(self):
        csrf = self.login()
        one = self.preview(self.data, csrf).get_data(as_text=True)
        two = self.preview(self.data, csrf).get_data(as_text=True)
        tokens = [re.search(r'name="token" value="([^"]+)"', t).group(1) for t in (one, two)]
        self.client.post('/admin/publish', data={'csrf': csrf, 'token': tokens[0]})
        response = self.client.post('/admin/publish', data={'csrf': csrf, 'token': tokens[1]})
        self.assertEqual(response.status_code, 409)

    def test_password_change_revokes_sessions_and_throttle(self):
        self.login()
        self.app.test_cli_runner().invoke(args=['set-admin-password', '--password', 'another-test-password-12345'])
        self.assertEqual(self.client.get('/admin').status_code, 302)
        token = self.csrf(self.client.get('/admin/login'))
        for _ in range(10):
            response = self.client.post('/admin/login', data={'csrf': token, 'password': 'wrong'})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.post('/admin/login', data={'csrf': token, 'password': 'wrong'}).status_code, 429)

    def test_multi_semester_arbitrary_groups_and_invalid_times(self):
        new = copy.deepcopy(self.data['semesters'][0])
        new.update(id='semester-6', title='Semester 6', start_date='2027-02-01', end_date='2027-06-18', default_group_id='orange')
        new['groups'] = [{'id':'orange', 'label':'Orange team'}]
        new['sessions'] = [{'id':'new-session','course_id':new['courses'][0]['id'],'weekday':6,'start_time':'18:15','end_time':'19:00','group_ids':['orange'],'week_interval':2,'anchor_date':'2027-02-01'}]
        new['events'] = []
        self.data['semesters'].append(new)
        self.data['active_semester_id'] = 'semester-6'
        validate_dataset(self.data)
        new['sessions'][0]['end_time'] = '18:00'
        with self.assertRaises(InvalidDataset):
            validate_dataset(self.data)
        with self.assertRaises(InvalidDataset):
            parse_json('{"a":1,"a":2}')
        with self.assertRaises(InvalidDataset):
            parse_json('{"a":NaN}')

    def test_official_calendar_and_overlaps(self):
        sem = self.data['semesters'][0]
        self.assertEqual((sem['start_date'], sem['end_date']), ('2026-09-14', '2027-01-29'))
        partial = next(e for e in sem['events'] if e['type'] == 'partial')
        finals = next(e for e in sem['events'] if e['type'] == 'final')
        self.assertEqual((partial['start_date'], partial['end_date']), ('2026-11-02', '2026-11-13'))
        self.assertEqual((finals['start_date'], finals['end_date']), ('2027-01-18', '2027-01-29'))
        conflict = copy.deepcopy(sem['sessions'][0])
        conflict['id'] = 'conflicting-slot'
        sem['sessions'].append(conflict)
        with self.assertRaises(InvalidDataset):
            validate_dataset(self.data)
        sem['sessions'][0].update(week_interval=2, anchor_date='2026-09-14')
        conflict.update(week_interval=2, anchor_date='2026-09-21')
        validate_dataset(self.data)


if __name__ == '__main__':
    unittest.main()
