# JSON import format · version 1

Future request: “Use this current JSON, calendar, and timetable to produce a complete Semester Planner import matching the attached schema. Preserve earlier semesters, use stable IDs, validate group assignments, and set the intended active semester.”

The JSON contains no executable code, HTML, passwords, or server settings. Text is displayed as text. Upload the complete document through `/admin`, not an individual semester object.

## Root

| Field | Meaning |
|---|---|
| `schema_version` | Always `1`. |
| `active_semester_id` | Semester shown by default on opening. Must exist in `semesters`. |
| `semesters` | One or more complete semester objects. Existing semesters stay available only if retained here. |
| `calendar_events` | Shared calendar entries shown for every semester, such as national holidays and the between-semester break. |

IDs use letters, digits, underscores, or hyphens, up to 64 characters. Preserve IDs when correcting existing entries; this helps retain students' personal overrides. Display labels and titles can be any language. Dates are ISO `YYYY-MM-DD`; times are 24-hour `HH:MM`. Unknown fields are rejected to catch typos.

## Each semester

- `id`, `title`, `start_date`, `end_date`: distinct ID, visible name, and inclusive boundaries. Include finals in `end_date` if the countdown should run through them. Semesters need not share start dates or group structures.
- `groups`: objects with `id` and `label`. IDs can be `A1`, `blue`, `lab-3`, or another formation. Nothing in the app assumes A/B/C groups.
- `default_group_id`: one of that semester's group IDs. A student can save a different default locally.
- `courses`: objects with `id`, `title`, and `kind` (`lecture`, `lab`, or `tutorial`).
- `sessions`: recurring timetable slots referencing course IDs and explicit group IDs.
- `events`: entries belonging only to this semester. Use `calendar_events` for shared dates.

## Session fields

Required: `id`, `course_id`, `weekday`, `start_time`, `end_time`, `group_ids`.

- `weekday`: Monday = `1`, Tuesday = `2`, … Sunday = `7`.
- `group_ids: []` means everyone. Otherwise list every group that attends. For an OOP group shared by A1 and A2, use `["A1", "A2"]`; the app does not infer membership from names.
- Optional `start_date` / `end_date` narrow the session's validity within the semester. To change a course's timetable mid-semester, create separate sessions with nonoverlapping date ranges.
- Optional `week_interval` defaults to `1`. For an every-other-week lab, set `2` and supply `anchor_date`: any date in its first active Monday–Sunday week. The interval repeats in both directions from that anchor within the session's valid dates. Give different groups different anchor weeks if needed.
- Optional `excluded_dates` skips specific occurrences.
- Optional `location` records a room/location. The import preserves it; the student course card displays it when supplied.
- Sessions must end after they start on the same date. Split overnight sessions into separate days. Different groups may have simultaneous sessions; conflicting sessions for the same group are rejected. The visible timeline expands to include imported hours.

## Event fields

Required: `id`, `title`, `type`, `start_date`, `end_date`.

| Type | Effect |
|---|---|
| `important` | Note/milestone; regular classes remain. |
| `holiday` | Yellow; removes classes. |
| `break` | Green; removes classes. |
| `exam`, `partial`, `final` | Red; shows Exam day, removes regular classes. |

Optional: `details` (up to 1,000 characters), `weekdays_only` (default false), and `excluded_dates` (dates inside the event range). Single-day entries use the same start/end. Multiple entries may share a date. Exams take visual priority if an exam and holiday are both explicitly added on the same day; when the official calendar has a holiday inside an exam period, exclude that date from the exam event.

Semester and event ranges are limited to three years and dates from 2000 through 2100. Maximum upload size: 2 MB. The schema defines remaining limits.

## Minimal illustrative document

This is a format example, not a real Semester 6 timetable. Merge a real future semester into the current export rather than uploading this example unchanged.

```json
{
  "schema_version": 1,
  "active_semester_id": "semester-example",
  "calendar_events": [],
  "semesters": [
    {
      "id": "semester-example",
      "title": "Example semester",
      "start_date": "2027-02-08",
      "end_date": "2027-06-25",
      "default_group_id": "blue",
      "groups": [{"id": "blue", "label": "Blue team"}],
      "courses": [{"id": "example-course", "title": "Example course", "kind": "lab"}],
      "sessions": [
        {
          "id": "example-lab",
          "course_id": "example-course",
          "weekday": 2,
          "start_time": "09:00",
          "end_time": "11:00",
          "group_ids": ["blue"],
          "week_interval": 2,
          "anchor_date": "2027-02-08",
          "location": "Lab 2"
        }
      ],
      "events": [
        {
          "id": "example-finals",
          "title": "Final exams",
          "type": "final",
          "start_date": "2027-06-14",
          "end_date": "2027-06-25",
          "weekdays_only": true,
          "excluded_dates": ["2027-06-16"]
        },
        {
          "id": "example-holiday",
          "title": "Holiday",
          "type": "holiday",
          "start_date": "2027-06-16",
          "end_date": "2027-06-16"
        }
      ]
    }
  ]
}
```
