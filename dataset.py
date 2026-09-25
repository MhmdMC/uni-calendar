"""Validate the complete import before any live data is changed."""
import json
from datetime import date, timedelta
from pathlib import Path
from jsonschema import Draft202012Validator, FormatChecker

SCHEMA = json.loads(Path(__file__).with_name('schema.json').read_text(encoding='utf-8'))
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


class InvalidDataset(ValueError):
    pass


def parse_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise InvalidDataset(f'Duplicate JSON key: {key}')
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=unique, parse_constant=lambda v: (_ for _ in ()).throw(InvalidDataset(f'Invalid number: {v}')))
    except (ValueError, RecursionError) as exc:
        raise InvalidDataset(f'Invalid JSON: {exc}') from exc


def validate_dataset(data):
    try:
        errors = sorted(VALIDATOR.iter_errors(data), key=lambda e: str(list(e.path)))
    except RecursionError as exc:
        raise InvalidDataset('JSON nesting is too deep.') from exc
    if errors:
        error = errors[0]
        path = '.'.join(map(str, error.absolute_path)) or 'document'
        raise InvalidDataset(f'{path}: {error.message}')

    def unique(items, label):
        ids = [item['id'] for item in items]
        if len(ids) != len(set(ids)):
            raise InvalidDataset(f'{label}: IDs must be unique.')
        return set(ids)

    def check_dates(start, end, label):
        if end < start:
            raise InvalidDataset(f'{label}: end date is before start date.')
        if not (date(2000, 1, 1) <= date.fromisoformat(start) <= date.fromisoformat(end) <= date(2100, 12, 31)):
            raise InvalidDataset(f'{label}: dates must fall between 2000 and 2100.')
        if (date.fromisoformat(end) - date.fromisoformat(start)).days > 1096:
            raise InvalidDataset(f'{label}: a date range cannot exceed three years.')

    def check_events(events, label):
        unique(events, label)
        for event in events:
            check_dates(event['start_date'], event['end_date'], event['id'])
            if not event['title'].strip():
                raise InvalidDataset(f'{event["id"]}: title cannot be blank.')
            if any(d < event['start_date'] or d > event['end_date'] for d in event.get('excluded_dates', [])):
                raise InvalidDataset(f'{event["id"]}: excluded dates must be inside its date range.')

    ids = unique(data['semesters'], 'semesters')
    if data['active_semester_id'] not in ids:
        raise InvalidDataset('active_semester_id must match a semester ID.')
    check_events(data['calendar_events'], 'calendar_events')
    for sem in data['semesters']:
        check_dates(sem['start_date'], sem['end_date'], sem['id'])
        if not sem['title'].strip():
            raise InvalidDataset('Semester title cannot be blank.')
        groups = unique(sem['groups'], sem['id'] + '.groups')
        courses = unique(sem['courses'], sem['id'] + '.courses')
        if sem['default_group_id'] not in groups:
            raise InvalidDataset(f'{sem["id"]}: default_group_id must match a group.')
        if any(not g['label'].strip() for g in sem['groups']) or any(not c['title'].strip() for c in sem['courses']):
            raise InvalidDataset(f'{sem["id"]}: group labels and course titles cannot be blank.')
        unique(sem['sessions'], sem['id'] + '.sessions')
        check_events(sem['events'], sem['id'] + '.events')
        for item in sem['sessions']:
            label = f'{sem["id"]}.{item["id"]}'
            if item['course_id'] not in courses or not set(item['group_ids']).issubset(groups):
                raise InvalidDataset(f'{label}: unknown course or group ID.')
            if item['end_time'] <= item['start_time']:
                raise InvalidDataset(f'{label}: end time must be after start time (same day).')
            start, end = item.get('start_date', sem['start_date']), item.get('end_date', sem['end_date'])
            check_dates(start, end, label)
            if start < sem['start_date'] or end > sem['end_date']:
                raise InvalidDataset(f'{label}: session dates must fall inside the semester.')
            if item.get('week_interval', 1) > 1 and 'anchor_date' not in item:
                raise InvalidDataset(f'{label}: recurring intervals require an anchor_date.')
            if 'anchor_date' in item and not '2000-01-01' <= item['anchor_date'] <= '2100-12-31':
                raise InvalidDataset(f'{label}: anchor_date is outside supported dates.')
            if any(d < start or d > end for d in item.get('excluded_dates', [])):
                raise InvalidDataset(f'{label}: excluded dates must fall inside session dates.')
        # Reject same-group double bookings, while allowing alternating lab weeks.
        def happens(item, day):
            if day.isoformat() in item.get('excluded_dates', []):
                return False
            interval = item.get('week_interval', 1)
            if interval == 1:
                return True
            anchor = date.fromisoformat(item['anchor_date'])
            anchor -= timedelta(days=anchor.weekday())
            week = day - timedelta(days=day.weekday())
            return ((week - anchor).days // 7) % interval == 0

        for weekday in range(1, 8):
            slots = sorted((s for s in sem['sessions'] if s['weekday'] == weekday), key=lambda s: s['start_time'])
            for i, first in enumerate(slots):
                for second in slots[i + 1:]:
                    if second['start_time'] >= first['end_time']:
                        break
                    if not (set(first['group_ids'] or groups) & set(second['group_ids'] or groups)):
                        continue
                    start = max(first.get('start_date', sem['start_date']), second.get('start_date', sem['start_date']))
                    end = min(first.get('end_date', sem['end_date']), second.get('end_date', sem['end_date']))
                    cursor = date.fromisoformat(start)
                    cursor += timedelta(days=(weekday - cursor.isoweekday()) % 7)
                    while cursor.isoformat() <= end:
                        if happens(first, cursor) and happens(second, cursor):
                            raise InvalidDataset(f'{sem["id"]}: {first["id"]} and {second["id"]} overlap for the same group on {cursor.isoformat()}.')
                        cursor += timedelta(days=7)
    return data


def summary(data):
    return [dict(id=s['id'], title=s['title'], start=s['start_date'], end=s['end_date'], groups=len(s['groups']), courses=len(s['courses']), sessions=len(s['sessions']), events=len(s['events'])) for s in data['semesters']]
