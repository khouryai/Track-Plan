"""The rules the server enforces: accounts, the look-ahead, and the TAWR workflow.

    python3 -m unittest tests/test_server.py -v

Every refusal here is one the browser would never offer — which is the point:
the screen is not the control, the server is. A requester cannot approve, an
approved request cannot change, a viewer cannot write, and a change from
another site is refused before anything else is read.
"""
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import operations as ops  # noqa: E402

WF = ops.load_workflow()
MON = "2026-11-02"


def record(key, flags=None, shift="day", week=MON):
    return {"week_start": week, "group_key": key, "shift": shift, "location_name": key, "first_day": week,
            "fields": {"row1_area": key}, "generated": {"row1_area": key},
            "source": {"flags": flags or [], "days": [{"date": week}], "activities": []}}


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "ops.db")
        ops.init_db(self.path)
        self.con = ops.connect(self.path)
        self.manager = ops.create_user(self.con, "tam", "Terry Manager", "requester", "manager-pass")
        self.requester = ops.create_user(self.con, "req", "Rae Requester", "requester", "requester-pass", self.manager)
        self.viewer = ops.create_user(self.con, "view", "Vic Viewer", "viewer", "viewer-pass", self.manager)

    def tearDown(self):
        self.con.close()
        shutil.rmtree(self.dir)

    def refused(self, fn, *a, status=None, **kw):
        with self.assertRaises(ops.Refused) as cm:
            fn(*a, **kw)
        if status:
            self.assertEqual(cm.exception.status, status, str(cm.exception))
        return cm.exception

    def draft(self, key="loc:tcr:Colma|day", **kw):
        return ops.create_tawr(self.con, record(key, **kw), self.requester, WF)

    def consolidated(self, before_submit=None):
        a, b = self.draft("a|day"), self.draft("b|day")
        if before_submit:
            before_submit(a, b)
        a = ops.act_on_tawr(self.con, a["id"], "submit", self.requester, WF)
        b = ops.act_on_tawr(self.con, b["id"], "submit", self.requester, WF)
        merge = {"id": "m-0001-abcd", "week_start": MON, "keys": ["a|day", "b|day"]}
        m = ops.consolidate(self.con, [a["id"], b["id"]], merge, record("merge:m-0001-abcd"), self.manager, WF)
        return a, b, m

    def files(self):
        return self.con.execute("SELECT count(*) FROM files").fetchone()[0]


class Accounts(Base):
    def test_first_account_is_the_manager(self):
        self.assertEqual(self.manager["role"], "manager")

    def test_only_the_manager_adds_accounts(self):
        self.refused(ops.create_user, self.con, "x1", "X", "requester", "password1", self.requester)

    def test_passwords_are_hashed_and_checked(self):
        stored = self.con.execute("SELECT password_hash FROM users WHERE username='req'").fetchone()[0]
        self.assertNotIn("requester-pass", stored)
        token, user = ops.login(self.con, "req", "requester-pass")
        self.assertEqual(ops.user_for_token(self.con, token)["id"], user["id"])
        self.assertEqual(ops.login(self.con, "req", "wrong")[0], None)

    def test_deactivating_signs_out(self):
        token, _ = ops.login(self.con, "req", "requester-pass")
        ops.update_user(self.con, self.requester["id"], {"active": False}, self.manager)
        self.assertIsNone(ops.user_for_token(self.con, token))

    def test_there_is_always_a_manager(self):
        self.refused(ops.update_user, self.con, self.manager["id"], {"role": "requester"}, self.manager, status=409)


class Lookahead(Base):
    def test_ops_round_trip(self):
        ops.apply_ops(self.con, [
            {"op": "row", "id": "a1", "set": {"kind": "activity", "description": "IXL", "sort": 1,
                                              "link": {"location_id": "tcr:Colma", "limits": [], "geometry": [[[0, 0], [1, 1]]]}}},
            {"op": "cell", "row_id": "a1", "day": MON, "color": "ffff00", "text": "X.WIT"},
        ], self.requester, WF)
        la = ops.lookahead(self.con)
        self.assertEqual(la["rows"][0]["link"]["location_id"], "tcr:Colma")
        self.assertEqual(la["cells"][0]["color"], "FFFF00")
        self.assertEqual(la["version"], 1)
        ops.apply_ops(self.con, [{"op": "cell", "row_id": "a1", "day": MON, "color": None, "text": ""},
                                 {"op": "delete_row", "id": "a1"}], self.requester, WF)
        self.assertEqual(ops.lookahead(self.con)["rows"], [])

    def test_a_viewer_cannot_edit(self):
        self.refused(ops.apply_ops, self.con, [{"op": "row", "id": "a", "set": {}}], self.viewer, WF, status=403)

    def test_a_bad_op_changes_nothing(self):
        self.refused(ops.apply_ops, self.con, [
            {"op": "row", "id": "a1", "set": {"kind": "activity"}},
            {"op": "cell", "row_id": "a1", "day": "not a day", "color": None, "text": "X"},
        ], self.requester, WF, status=400)
        self.assertEqual(ops.lookahead(self.con)["rows"], [])

    def test_a_cell_on_a_deleted_row_is_refused(self):
        self.refused(ops.apply_ops, self.con, [{"op": "cell", "row_id": "nope", "day": MON, "color": "FFFF00", "text": ""}],
                     self.requester, WF, status=409)


class Workflow(Base):
    def test_a_new_request_is_always_a_draft(self):
        r = ops.create_tawr(self.con, {**record("k|day"), "status": "approved"}, self.requester, WF)
        self.assertEqual(r["status"], "draft")

    def test_one_live_request_per_place_and_shift(self):
        self.draft()
        self.refused(self.draft, status=409)

    def test_requester_submits_manager_approves(self):
        r = self.draft()
        r = ops.act_on_tawr(self.con, r["id"], "submit", self.requester, WF)
        self.assertEqual(r["status"], "submitted")
        self.refused(ops.act_on_tawr, self.con, r["id"], "approve", self.requester, WF, status=403)
        r = ops.act_on_tawr(self.con, r["id"], "approve", self.manager, WF)
        self.assertEqual((r["status"], r["decided_by"]), ("approved", self.manager["id"]))
        self.assertEqual([h["action"] for h in r["history"]], ["created", "submit", "approve"])

    def test_an_unsubmitted_draft_is_not_approved(self):
        r = self.draft()
        self.refused(ops.act_on_tawr, self.con, r["id"], "approve", self.manager, WF, status=409)

    def test_a_flagged_request_cannot_be_submitted(self):
        r = self.draft(flags=[{"kind": "location_unlinked", "blocking": True, "message": "link it"}])
        e = self.refused(ops.act_on_tawr, self.con, r["id"], "submit", self.requester, WF, status=409)
        self.assertIn("link it", str(e))

    def test_reject_says_why_and_reopens(self):
        r = ops.act_on_tawr(self.con, self.draft()["id"], "submit", self.requester, WF)
        self.refused(ops.act_on_tawr, self.con, r["id"], "reject", self.manager, WF, status=400)
        r = ops.act_on_tawr(self.con, r["id"], "reject", self.manager, WF, note="wrong limits")
        self.assertEqual((r["status"], r["decision_note"]), ("rejected", "wrong limits"))
        r = ops.act_on_tawr(self.con, r["id"], "reopen", self.requester, WF)
        self.assertEqual(r["status"], "draft")

    def test_approved_is_final_and_revised(self):
        r = ops.act_on_tawr(self.con, self.draft()["id"], "submit", self.requester, WF)
        r = ops.act_on_tawr(self.con, r["id"], "approve", self.manager, WF)
        self.refused(ops.update_tawr, self.con, r["id"], {"fields": {"row1_area": "x"}}, self.manager, WF, status=403)
        self.refused(ops.update_tawr, self.con, r["id"], {"source": {}}, self.manager, WF, status=409)
        self.refused(ops.act_on_tawr, self.con, r["id"], "discard", self.manager, WF, status=409)
        new = ops.act_on_tawr(self.con, r["id"], "revise", self.requester, WF)
        self.assertEqual((new["status"], new["supersedes"]), ("draft", r["id"]))
        old = [t for t in ops.list_tawrs(self.con) if t["id"] == r["id"]][0]
        self.assertEqual(old["status"], "superseded")

    def approved(self, key="loc:tcr:Colma|day", days=("2026-11-02", "2026-11-03")):
        rec = record(key)
        rec["source"]["days"] = [{"date": d} for d in days]
        r = ops.create_tawr(self.con, rec, self.requester, WF)
        r = ops.act_on_tawr(self.con, r["id"], "submit", self.requester, WF)
        return ops.act_on_tawr(self.con, r["id"], "approve", self.manager, WF)

    def test_what_bart_said_is_recorded_after_approval(self):
        draft = self.draft("k|day")
        self.refused(ops.record_bart, self.con, draft["id"], {"sent_on": "2026-10-14"}, self.requester, WF, status=409)
        r = self.approved()
        r = ops.record_bart(self.con, r["id"], {"sent_on": "2026-10-14", "ref": " BT-4471 "}, self.requester, WF)
        self.assertEqual((r["bart"]["sent_on"], r["bart"]["ref"], r["bart"].get("answer")), ("2026-10-14", "BT-4471", None))
        r = ops.record_bart(self.con, r["id"], {"answer": "granted", "answered_on": "2026-10-16"}, self.manager, WF)
        self.assertEqual((r["bart"]["answer"], r["bart"]["sent_on"], r["status"]), ("granted", "2026-10-14", "approved"))
        self.assertIn("BART granted it", r["history"][-1]["action"])
        for bad in ({"answer": "denied"}, {"sent_on": "14/10/2026"}, {"ref": "x" * 61}, {"released_on": "2026-10-20"}):
            self.refused(ops.record_bart, self.con, r["id"], bad, self.requester, WF, status=400 if "released_on" not in bad else 409)
        self.refused(ops.record_bart, self.con, r["id"], {"ref": "y"}, self.viewer, WF, status=403)

    def test_bart_denying_ends_it_with_the_reason_and_it_can_be_reopened(self):
        r = self.approved()
        self.refused(ops.act_on_tawr, self.con, r["id"], "deny", self.requester, WF, status=400)
        r = ops.act_on_tawr(self.con, r["id"], "deny", self.requester, WF, note="No flagger available", on="2026-10-17")
        self.assertEqual((r["status"], r["bart"]["answer"], r["bart"]["note"], r["bart"]["answered_on"]), ("denied", "denied", "No flagger available", "2026-10-17"))
        self.refused(ops.record_access, self.con, r["id"], {"days": {"2026-11-02": True}}, self.requester, WF, status=409)
        self.assertEqual(ops.act_on_tawr(self.con, r["id"], "reopen", self.requester, WF)["status"], "draft")

    def test_a_cancelled_request_releases_the_track(self):
        r = self.approved()
        self.refused(ops.act_on_tawr, self.con, r["id"], "cancel", self.requester, WF, status=400)
        r = ops.act_on_tawr(self.con, r["id"], "cancel", self.requester, WF, note="Work moved a week", on="2026-10-20")
        self.assertEqual((r["status"], r["bart"].get("released_on")), ("cancelled", None))
        r = ops.record_bart(self.con, r["id"], {"released_on": "2026-10-21"}, self.requester, WF)
        self.assertEqual(r["bart"]["released_on"], "2026-10-21")
        told = ops.act_on_tawr(self.con, self.approved("k2|day")["id"], "cancel", self.manager, WF, note="Rain", released=True, on="2026-10-20")
        self.assertEqual(told["bart"]["released_on"], "2026-10-20")
        # Cancelled is not live: the place and shift can be asked for again once it is reopened.
        self.assertEqual(ops.act_on_tawr(self.con, told["id"], "reopen", self.requester, WF)["status"], "draft")

    def test_the_access_used_is_recorded_day_by_day(self):
        r = self.approved()
        r = ops.record_access(self.con, r["id"], {"days": {"2026-11-02": True, "2026-11-03": False}, "note": "Rained off Tuesday"}, self.requester, WF)
        self.assertEqual((r["access"]["days"], r["access"]["note"]), ({"2026-11-02": True, "2026-11-03": False}, "Rained off Tuesday"))
        self.assertIn("used on 1 of 2 days", r["history"][-1]["action"])
        for bad in ({"days": {}}, {"days": {"2026-11-09": True}}, {"days": {"2026-11-02": "yes"}}, {"days": {"2026-11-02": True}, "note": "n" * 1001}):
            self.refused(ops.record_access, self.con, r["id"], bad, self.requester, WF, status=400)
        self.refused(ops.record_access, self.con, r["id"], {"days": {"2026-11-02": True}}, self.viewer, WF, status=403)

    def test_an_older_database_is_upgraded_with_its_requests(self):
        path = os.path.join(self.dir, "old.db")
        con = ops.connect(path)
        with open(ops.SCHEMA) as f:
            schema = f.read()
        old = (schema.replace("'denied', 'cancelled',\n                                    ", "")
               .replace("    bart          TEXT,                     -- {sent_on, ref, answer, answered_on, note, released_on, by}\n", "")
               .replace("    access        TEXT,                     -- {days: {YYYY-MM-DD: used?}, note, on, by}\n", ""))
        self.assertNotIn("'cancelled'", old)
        con.executescript(old)
        con.execute("INSERT INTO tawrs(id, week_start, group_key, shift, status) VALUES (7, ?, 'k|day', 'day', 'approved')", (MON,))
        con.execute("INSERT INTO tawrs(id, week_start, group_key, shift, status, supersedes) VALUES (8, ?, 'k2|day', 'day', 'draft', 7)", (MON,))
        con.close()
        ops.init_db(path)
        con = ops.connect(path)
        try:
            rows = {t["id"]: t for t in ops.list_tawrs(con)}
            self.assertEqual((rows[7]["status"], rows[8]["supersedes"], rows[7]["bart"]), ("approved", 7, {}))
            con.execute("UPDATE tawrs SET status = 'cancelled' WHERE id = 7")
            self.assertTrue(con.execute("SELECT 1 FROM sqlite_master WHERE name = 'tawrs_current'").fetchone())
            ops.init_db(path)  # and a second start changes nothing
            self.assertEqual(ops.list_tawrs(con)[0]["status"], "cancelled")
        finally:
            con.close()

    def test_a_calendar_link_is_one_per_person_and_can_be_stopped(self):
        first = ops.make_calendar_token(self.con, self.viewer)["token"]
        self.assertEqual(ops.calendar_user(self.con, first)["id"], self.viewer["id"])
        second = ops.make_calendar_token(self.con, self.viewer)["token"]
        self.assertIsNone(ops.calendar_user(self.con, first))  # the new link replaces the old
        self.assertEqual(ops.calendar_user(self.con, second)["id"], self.viewer["id"])
        self.assertEqual(ops.stop_calendar_token(self.con, self.viewer), {"stopped": True})
        self.assertIsNone(ops.calendar_user(self.con, second))
        self.refused(ops.make_calendar_token, self.con, None, status=401)

    def test_the_calendar_says_the_deadlines_and_the_access(self):
        from datetime import date, datetime, timezone
        rec = record("loc:tcr:Colma|night", shift="night")
        rec["source"]["days"] = [{"date": MON, "start": "2230", "end": "0430"}, {"date": "2026-11-03", "start": "", "end": ""}]
        rec["source"]["activities"] = [{"activityId": "C-M301", "title": "ATC loop cable, Glen Park"}]
        r = ops.create_tawr(self.con, rec, self.requester, WF)
        ops.act_on_tawr(self.con, r["id"], "submit", self.requester, WF)
        ops.act_on_tawr(self.con, r["id"], "approve", self.manager, WF)
        ops.record_bart(self.con, r["id"], {"sent_on": "2026-10-16", "ref": "BT-1", "answer": "granted"}, self.requester, WF)
        ics = ops.calendar_ics(self.con, today=date(2026, 10, 16), stamp=datetime(2026, 10, 16, 22, 0, tzinfo=timezone.utc))
        lines = ics.split("\r\n")
        self.assertTrue(ics.startswith("BEGIN:VCALENDAR\r\n") and ics.endswith("END:VCALENDAR\r\n"))
        self.assertIn("UID:deadline-2026-11-02@track-plan", lines)
        self.assertIn("DTSTART;VALUE=DATE:20261016", lines)  # 17 days before Mon 2 Nov
        self.assertIn("TRIGGER:-PT15H", lines)
        self.assertIn("DTSTART:20261102T223000", lines)
        self.assertIn("DTEND:20261103T043000", lines)  # a night shift ends the next morning
        self.assertIn("DTSTART;VALUE=DATE:20261103", lines)  # a day without hours is the whole day
        self.assertIn("STATUS:CONFIRMED", lines)
        unfolded = ics.replace("\r\n ", "")
        self.assertIn("DESCRIPTION:C-M301 ATC loop cable\\, Glen Park\\nGranted by BART (BT-1).", unfolded)
        self.assertTrue(all(len(line.encode()) <= 75 for line in lines))

    def test_submitted_is_the_managers_to_edit(self):
        r = ops.act_on_tawr(self.con, self.draft()["id"], "submit", self.requester, WF)
        self.refused(ops.update_tawr, self.con, r["id"], {"fields": {"a": "b"}}, self.requester, WF, status=403)
        r = ops.update_tawr(self.con, r["id"], {"fields": {"a": "b"}}, self.manager, WF)
        self.assertEqual(r["fields"], {"a": "b"})

    def test_only_a_draft_follows_the_lookahead(self):
        r = ops.act_on_tawr(self.con, self.draft()["id"], "submit", self.requester, WF)
        self.refused(ops.update_tawr, self.con, r["id"], {"generated": {}}, self.requester, WF, status=409)

    def test_a_viewer_does_nothing(self):
        r = self.draft()
        self.refused(ops.act_on_tawr, self.con, r["id"], "submit", self.viewer, WF, status=403)
        self.refused(ops.create_tawr, self.con, record("v|day"), self.viewer, WF, status=403)
        self.refused(ops.set_settings, self.con, {"phases": "[]"}, self.viewer, WF, status=403)

    def test_a_viewer_reads_the_phases_and_nothing_else_of_the_setup(self):
        phases = '[{"id": "p2", "name": "Phase 2", "note": "W and Y lines", "bbox": [150, 940, 2010, 1260]}]'
        ops.set_settings(self.con, {"phases": phases, "person_in_charge_cell_phone": "415-555-0100"}, self.requester, WF)
        self.assertEqual(ops.get_settings(self.con, self.viewer, WF), {"phases": phases})
        self.assertEqual(ops.get_settings(self.con, self.requester, WF)["person_in_charge_cell_phone"], "415-555-0100")

    def test_a_phase_needs_a_name_and_a_box(self):
        for bad in ('{"name": "x"}', '[{"bbox": [0, 0, 10, 10]}]', '[{"name": "P", "bbox": [10, 0, 0, 10]}]',
                    '[{"name": "P", "bbox": [0, 0, 10]}]', '[{"name": "P", "bbox": [0, 0, "a", 10]}]', 'not json'):
            self.refused(ops.set_settings, self.con, {"phases": bad}, self.requester, WF, status=400)
        ok = ops.set_settings(self.con, {"phases": '[{"name": "Phase 1", "bbox": [0, 0, 10.5, 10]}]'}, self.manager, WF)
        self.assertIn("Phase 1", ok["phases"])

    def test_the_memory_is_kept_for_those_who_raise_and_decide(self):
        entry = {"kind": "form", "tawr_id": 7, "data": {"action": "submit", "answers": {"power": "off"}}}
        kept = ops.add_memory(self.con, [entry, {"kind": "link", "data": {"title": "IXL"}}], self.requester, WF)
        self.assertEqual([e["kind"] for e in kept], ["form", "link"])
        self.assertEqual(kept[0]["by"], self.requester["name"])
        self.assertEqual(ops.list_memory(self.con, self.manager, WF)[0]["data"]["answers"], {"power": "off"})
        self.refused(ops.list_memory, self.con, self.viewer, WF, status=403)
        self.refused(ops.add_memory, self.con, [entry], self.viewer, WF, status=403)
        for bad in ([], [{"kind": "guess", "data": {}}], [{"kind": "form", "data": "text"}],
                    [{"kind": "form", "tawr_id": "7", "data": {}}], [{"kind": "form", "data": {"x": "y" * 20_001}}]):
            self.refused(ops.add_memory, self.con, bad, self.requester, WF, status=400)
        ops.forget_memory(self.con, kept[1]["id"], self.requester, WF)
        self.assertEqual(len(ops.list_memory(self.con, self.requester, WF)), 1)
        self.refused(ops.forget_memory, self.con, kept[1]["id"], self.requester, WF, status=404)
        self.refused(ops.clear_memory, self.con, self.requester, WF, status=403)
        self.assertEqual(ops.clear_memory(self.con, self.manager, WF), {"forgotten": 1})

    def test_what_bart_can_provide_is_checked(self):
        ops.set_settings(self.con, {"support_capacity": json.dumps({"X": {"night": 4, "day": 6}})}, self.requester, WF)
        self.assertEqual(json.loads(ops.get_settings(self.con)["support_capacity"])["X"]["night"], 4)
        for bad in ("[1]", "{", json.dumps({"X": {"night": 4.5}}), json.dumps({"X": {"evening": 1}}), json.dumps({"X": {"night": 100}}), json.dumps({"X": {"night": True}})):
            self.refused(ops.set_settings, self.con, {"support_capacity": bad}, self.requester, WF, status=400)

    def test_the_learning_settings_are_checked(self):
        ops.set_settings(self.con, {"learn_predict": "off", "learn_threshold": "0.75"}, self.requester, WF)
        self.assertEqual(ops.get_settings(self.con)["learn_threshold"], "0.75")
        for bad in ({"learn_predict": "maybe"}, {"learn_threshold": "0.2"}, {"learn_threshold": "nan"}, {"learn_threshold": "sure"}):
            self.refused(ops.set_settings, self.con, bad, self.requester, WF, status=400)

    def test_only_the_manager_consolidates(self):
        a, b = self.draft("a|day"), self.draft("b|day")
        merge = {"id": "m-0001-abcd", "week_start": MON, "keys": ["a|day", "b|day"]}
        self.refused(ops.consolidate, self.con, [a["id"], b["id"]], merge, record("merge:m-0001-abcd"),
                     self.requester, WF, status=403)

    def test_consolidating_makes_one_and_keeps_the_members(self):
        a, b, m = self.consolidated()
        self.assertEqual(m["status"], "submitted")  # both were submitted, so it is ready to approve
        live = {t["id"]: t for t in ops.list_tawrs(self.con)}
        self.assertEqual({live[a["id"]]["status"], live[b["id"]]["status"]}, {"consolidated"})
        self.assertEqual(live[a["id"]]["merged_into"], m["id"])
        self.assertEqual(ops.list_merges(self.con)[0]["keys"], ["a|day", "b|day"])
        ops.act_on_tawr(self.con, m["id"], "approve", self.manager, WF)

    def test_split_puts_them_back(self):
        a, b, m = self.consolidated()
        ops.split(self.con, m["id"], self.manager, WF)
        live = {t["id"]: t for t in ops.list_tawrs(self.con)}
        self.assertNotIn(m["id"], live)
        self.assertEqual(live[a["id"]]["status"], "submitted")
        self.assertEqual(ops.list_merges(self.con), [])

    def test_an_approved_consolidation_is_not_split(self):
        _, _, m = self.consolidated()
        ops.act_on_tawr(self.con, m["id"], "approve", self.manager, WF)
        self.refused(ops.split, self.con, m["id"], self.manager, WF, status=409)

    def test_consolidation_stays_in_one_week_and_shift(self):
        a, b = self.draft("a|day"), self.draft("b|night", shift="night")
        merge = {"id": "m-0002-abcd", "week_start": MON, "keys": ["a|day", "b|night"]}
        self.refused(ops.consolidate, self.con, [a["id"], b["id"]], merge, record("merge:m-0002-abcd"),
                     self.manager, WF, status=409)

    def test_a_tcr_and_track_are_never_consolidated(self):
        tcr = record("loc:tcr:Colma|day")
        tcr["source"]["kind"] = "tcr"
        trk = record("trk:W2 MP 16.600-16.900|day")
        trk["source"]["kind"] = "track"
        a = ops.create_tawr(self.con, tcr, self.requester, WF)
        b = ops.create_tawr(self.con, trk, self.requester, WF)
        merge = {"id": "m-0004-abcd", "week_start": MON, "keys": sorted([a["group_key"], b["group_key"]])}
        e = self.refused(ops.consolidate, self.con, [a["id"], b["id"]], merge, record("merge:m-0004-abcd"),
                         self.manager, WF, status=409)
        self.assertIn("TCR", str(e))

    def test_approved_requests_are_not_consolidated(self):
        a = ops.act_on_tawr(self.con, self.draft("a|day")["id"], "submit", self.requester, WF)
        ops.act_on_tawr(self.con, a["id"], "approve", self.manager, WF)
        b = self.draft("b|day")
        merge = {"id": "m-0003-abcd", "week_start": MON, "keys": ["a|day", "b|day"]}
        self.refused(ops.consolidate, self.con, [a["id"], b["id"]], merge, record("merge:m-0003-abcd"),
                     self.manager, WF, status=409)


class History(Base):
    """The look-ahead's history: who changed what and when, and what it was before."""

    def apply(self, batch, who=None):
        return ops.apply_ops(self.con, batch, who or self.requester, WF)

    def edits(self, **kw):
        return ops.list_edits(self.con, self.viewer, **kw)["edits"]

    def test_a_day_says_who_changed_it_and_what_it_was(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity", "activity_id": "C-W101", "description": "Cable trough", "sort": 1}},
                    {"op": "cell", "row_id": "a1", "day": MON, "color": "0070c0", "text": "X"}])
        self.apply([{"op": "cell", "row_id": "a1", "day": MON, "color": "FFC000", "text": "X.WIT"}], self.manager)
        self.apply([{"op": "cell", "row_id": "a1", "day": MON, "color": None, "text": ""}])
        day = self.edits(row="a1", day=MON)
        self.assertEqual([e["action"] for e in day], ["delete", "update", "insert"])  # newest first
        self.assertEqual(day[1]["by"], "Terry Manager")
        self.assertEqual((day[1]["before"], day[1]["after"]), ({"color": "0070C0", "text": "X"}, {"color": "FFC000", "text": "X.WIT"}))
        self.assertIsNone(day[0]["after"])
        self.assertEqual(day[2]["label"], "C-W101 · Cable trough")
        self.assertEqual(len({e["batch"] for e in day}), 3)  # one action, one batch

    def test_a_row_change_keeps_what_changed_and_never_the_geometry(self):
        link = {"location_id": "tcr:Colma", "location_name": "Colma TCR", "limits": [], "geometry": [[[0, 0], [1, 1]]]}
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity", "description": "IXL", "sort": 1}}])
        self.apply([{"op": "row", "id": "a1", "set": {"description": "IXL SIM Testing", "sort": 2, "link": link}}])
        self.apply([{"op": "row", "id": "a1", "set": {"sort": 3}}])  # moved: where it sits, not what it says
        row = self.edits(row="a1")
        self.assertEqual([e["action"] for e in row], ["update", "insert"])
        self.assertEqual(row[0]["before"], {"description": "IXL", "link": None})
        self.assertEqual(row[0]["after"], {"description": "IXL SIM Testing",
                                           "link": {"location_id": "tcr:Colma", "location_name": "Colma TCR", "limits": []}})

    def test_writing_a_day_as_it_was_is_no_change(self):
        cell = {"op": "cell", "row_id": "a1", "day": MON, "color": "FFFF00", "text": "X"}
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity"}}, cell])
        self.apply([cell])
        self.assertEqual(len(self.edits(row="a1", day=MON)), 1)

    def test_a_deleted_row_keeps_its_history_and_its_name(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity", "description": "Foundations"}},
                    {"op": "cell", "row_id": "a1", "day": MON, "color": "FFFF00", "text": ""}])
        self.apply([{"op": "cell", "row_id": "a1", "day": MON, "color": None, "text": ""}, {"op": "delete_row", "id": "a1"}])
        row = self.edits(row="a1")
        self.assertEqual((row[0]["action"], row[0]["before"]["description"], row[0]["label"]), ("delete", "Foundations", "Foundations"))

    def test_names_say_whose_they_are(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity", "activity_id": "T-1", "description": "Loop test"}},
                    {"op": "row", "id": "r1", "set": {"kind": "resource", "parent_id": "a1"}},
                    {"op": "cell", "row_id": "r1", "day": MON, "color": None, "text": "Ann Example"}])
        self.assertEqual(self.edits(row="r1", day=MON)[0]["label"], "Names under T-1 · Loop test")

    def test_an_import_is_one_line_and_so_is_the_legend(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity"}}])
        ops.replace_lookahead(self.con, [{"id": "b1", "kind": "activity", "description": "New"}],
                              [{"row_id": "b1", "day": MON, "color": "FFFF00", "text": ""}], self.requester, WF)
        last = self.edits(limit=1)[0]
        self.assertEqual((last["target"], last["before"], last["after"]), ("import", {"rows": 1, "cells": 0}, {"rows": 1, "cells": 1}))
        self.assertEqual(self.edits(row="b1"), [])
        ops.set_legend(self.con, ops.DEFAULT_LEGEND + [{"argb": "00B050", "meaning": "Possession", "role": "shift"}], self.manager, WF)
        self.assertEqual(self.edits(limit=1)[0]["target"], "legend")

    def test_what_changed_under_some_rows_since_a_moment(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity"}}, {"op": "row", "id": "a2", "set": {"kind": "activity"}}])
        self.con.execute("UPDATE la_edits SET at = '2026-10-01T00:00:00Z'")
        self.apply([{"op": "cell", "row_id": "a1", "day": MON, "color": "FFFF00", "text": ""},
                    {"op": "cell", "row_id": "a2", "day": MON, "color": "FFFF00", "text": ""}])
        since = self.edits(rows=["a1"], since="2026-10-02T00:00:00.000Z")
        self.assertEqual([(e["row_id"], e["target"]) for e in since], [("a1", "cell")])
        self.refused(ops.list_edits, self.con, None, status=401)
        self.refused(ops.list_edits, self.con, self.viewer, since="yesterday", status=400)

    def test_the_window_and_the_pages(self):
        self.apply([{"op": "row", "id": "a1", "set": {"kind": "activity"}}] + [
            {"op": "cell", "row_id": "a1", "day": f"2026-11-0{d}", "color": "FFFF00", "text": ""} for d in range(2, 9)])
        week = self.edits(start="2026-11-03", end="2026-11-04")
        self.assertEqual(sorted(e["day"] or "row" for e in week), ["2026-11-03", "2026-11-04", "row"])
        page = ops.list_edits(self.con, self.viewer, limit=3)
        rest = ops.list_edits(self.con, self.viewer, before=page["edits"][-1]["id"])
        self.assertEqual((page["more"], rest["more"], len(page["edits"]) + len(rest["edits"])), (True, False, 8))
        self.assertTrue(page["since"])  # the history says when it started


class Talk(Base):
    """What the requester and the manager say about a request, and what is new to whom."""

    def test_both_sides_talk_and_a_viewer_reads(self):
        t = self.draft()
        ops.add_comment(self.con, t["id"], "  Flagger is Ann Example, 415-555-0101  ", self.requester, WF)
        out = ops.add_comment(self.con, t["id"], "Thanks — put her on the form.", self.manager, WF)
        self.assertEqual([(c["by"], c["text"]) for c in out["comments"]],
                         [("Rae Requester", "Flagger is Ann Example, 415-555-0101"), ("Terry Manager", "Thanks — put her on the form.")])
        self.refused(ops.add_comment, self.con, t["id"], "hello", self.viewer, WF, status=403)
        self.assertEqual(len(ops.list_comments(self.con, t["id"], self.viewer)), 2)

    def test_a_comment_says_something_and_not_too_much(self):
        t = self.draft()
        self.refused(ops.add_comment, self.con, t["id"], "   ", self.requester, WF, status=400)
        self.refused(ops.add_comment, self.con, t["id"], "x" * 2001, self.requester, WF, status=400)
        self.refused(ops.add_comment, self.con, 999, "hello", self.requester, WF, status=404)

    def test_any_request_can_be_talked_about_at_any_point(self):
        tid = self.draft()["id"]
        ops.act_on_tawr(self.con, tid, "submit", self.requester, WF)
        ops.act_on_tawr(self.con, tid, "approve", self.manager, WF)
        self.assertEqual(len(ops.add_comment(self.con, tid, "Sent to BART today.", self.requester, WF)["comments"]), 1)

    def test_what_is_new_to_whom(self):
        tid = self.draft()["id"]
        said = ops.add_comment(self.con, tid, "Is the EIC booked?", self.manager, WF)["comments"][-1]
        read = lambda who: {r["id"]: r for r in ops.list_tawrs(self.con, actor=who)}[tid]["seen_comment"]  # noqa: E731
        self.assertEqual((read(self.manager), read(self.requester)), (said["id"], 0))  # what you wrote, you have read
        ops.mark_seen(self.con, tid, said["id"], self.requester)
        ops.mark_seen(self.con, tid, 0, self.requester)  # never back
        self.assertEqual(read(self.requester), said["id"])
        self.refused(ops.mark_seen, self.con, tid, "all", self.requester, status=400)

    def test_a_split_keeps_what_was_said_about_the_merged_request(self):
        a, b, m = self.consolidated()
        ops.add_comment(self.con, m["id"], "One request for both rooms.", self.manager, WF)
        ops.split(self.con, m["id"], self.manager, WF)
        live = {r["id"]: r for r in ops.list_tawrs(self.con)}
        self.assertEqual([c["text"] for c in live[a["id"]]["comments"]], ["One request for both rooms."])
        self.assertEqual([c["text"] for c in live[b["id"]]["comments"]], ["One request for both rooms."])


class Files(Base):
    """The files sent with a request: the SSWP, drawings, permits."""
    PDF = b"%PDF-1.4\n% SSWP\n"

    def attach(self, tid, name="SSWP 12.pdf", data=None, who=None):
        return ops.add_attachment(self.con, tid, name, self.PDF if data is None else data, who or self.requester, WF)

    def test_a_draft_takes_files_and_anybody_signed_in_reads_them(self):
        t = self.draft()
        out = self.attach(t["id"], "C:\\Users\\rae\\SSWP 12.pdf")
        a = out["attachments"][0]
        self.assertEqual((a["name"], a["type"], a["size"], a["by"]), ("SSWP 12.pdf", "application/pdf", len(self.PDF), "Rae Requester"))
        self.assertEqual(out["history"][-1]["action"], "attached SSWP 12.pdf")
        self.assertEqual(ops.get_attachment(self.con, a["id"], self.viewer), ("SSWP 12.pdf", "application/pdf", self.PDF))
        self.refused(ops.get_attachment, self.con, a["id"], None, status=401)
        self.refused(ops.get_attachment, self.con, 999, self.viewer, status=404)

    def test_files_change_where_the_fields_do(self):
        t = self.draft()
        self.refused(self.attach, t["id"], who=self.viewer, status=403)
        ops.act_on_tawr(self.con, t["id"], "submit", self.requester, WF)
        self.refused(self.attach, t["id"], status=409)  # submitted: the manager's to change
        out = self.attach(t["id"], "Barrier plan.pdf", who=self.manager)
        ops.act_on_tawr(self.con, t["id"], "approve", self.manager, WF)
        self.refused(ops.delete_attachment, self.con, t["id"], out["attachments"][0]["id"], self.manager, WF, status=409)
        self.refused(self.attach, t["id"], who=self.manager, status=409)  # approved is final

    def test_only_documents_and_never_too_big(self):
        t = self.draft()
        self.refused(self.attach, t["id"], "install.exe", status=415)
        self.refused(self.attach, t["id"], "page.html", status=415)
        self.refused(self.attach, t["id"], "no extension", status=415)
        self.refused(self.attach, t["id"], "empty.pdf", b"", status=400)
        self.refused(self.attach, t["id"], "big.pdf", b"0" * (ops.ATTACH_MAX + 1), status=413)
        for i in range(ops.ATTACH_PER_REQUEST):
            self.attach(t["id"], f"page {i}.png", b"%PNG" + bytes([i]))
        self.refused(self.attach, t["id"], "one more.png", status=409)

    def test_a_file_is_kept_once_and_goes_with_its_last_copy(self):
        t = self.draft()
        one = self.attach(t["id"], "a.pdf")["attachments"][0]
        two = self.attach(t["id"], "b.pdf")["attachments"][1]
        self.assertEqual((one["sha256"], self.files()), (two["sha256"], 1))
        ops.delete_attachment(self.con, t["id"], one["id"], self.requester, WF)
        self.assertEqual(self.files(), 1)
        out = ops.delete_attachment(self.con, t["id"], two["id"], self.requester, WF)
        self.assertEqual((out["attachments"], self.files(), out["history"][-1]["action"]), ([], 0, "removed b.pdf"))

    def test_a_revision_carries_the_files_and_the_approved_one_keeps_them(self):
        t = self.draft()
        self.attach(t["id"])
        ops.act_on_tawr(self.con, t["id"], "submit", self.requester, WF)
        ops.act_on_tawr(self.con, t["id"], "approve", self.manager, WF)
        rev = ops.act_on_tawr(self.con, t["id"], "revise", self.requester, WF)
        self.assertEqual([a["name"] for a in rev["attachments"]], ["SSWP 12.pdf"])
        self.assertIsNotNone(rev["attachments"][0]["copied_from"])
        ops.delete_attachment(self.con, rev["id"], rev["attachments"][0]["id"], self.requester, WF)
        old = {r["id"]: r for r in ops.list_tawrs(self.con)}[t["id"]]
        self.assertEqual((len(old["attachments"]), self.files()), (1, 1))

    def test_discarding_a_draft_drops_its_files(self):
        t = self.draft()
        self.attach(t["id"])
        ops.act_on_tawr(self.con, t["id"], "discard", self.requester, WF)
        self.assertEqual(self.files(), 0)

    def test_consolidating_carries_files_in_and_a_split_gives_back_what_was_added(self):
        def before_submit(a, b):
            self.attach(a["id"], "a.pdf")
            self.attach(b["id"], "b.pdf", b"%PDF-1.4 b")
        a, b, m = self.consolidated(before_submit)
        self.assertEqual(sorted(x["name"] for x in m["attachments"]), ["a.pdf", "b.pdf"])
        self.attach(m["id"], "barrier.pdf", b"%PDF-1.4 c", who=self.manager)
        ops.split(self.con, m["id"], self.manager, WF)
        live = {r["id"]: r for r in ops.list_tawrs(self.con)}
        self.assertEqual(sorted(x["name"] for x in live[a["id"]]["attachments"]), ["a.pdf", "barrier.pdf"])
        self.assertEqual(sorted(x["name"] for x in live[b["id"]]["attachments"]), ["b.pdf", "barrier.pdf"])
        self.assertEqual(self.files(), 3)


class Http(unittest.TestCase):
    """The server itself: cookies, and a change from another site refused."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        ops.OPS_DB = os.path.join(cls.dir, "ops.db")
        ops.TEMPLATE_PATH = os.path.join(cls.dir, "tawr.pdf")
        ops.init_db(ops.OPS_DB)
        import server
        cls.srv = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.port = cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        shutil.rmtree(cls.dir)

    def call(self, method, path, body=None, cookie=None, same_site=True, raw=None, ctype="application/json"):
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        headers = {"Content-Type": ctype}
        if same_site:
            headers["X-Requested-With"] = "trackplan"
        if cookie:
            headers["Cookie"] = cookie
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        payload = r.read()
        set_cookie = r.getheader("Set-Cookie")
        c.close()
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
        return r.status, payload, set_cookie

    def test_flow(self):
        status, me, _ = self.call("GET", "/api/me")
        self.assertEqual((status, me["setup_needed"]), (200, True))
        status, _, _ = self.call("POST", "/api/setup", {"username": "tam", "name": "T", "password": "pass-word"}, same_site=False)
        self.assertEqual(status, 403)
        status, out, cookie = self.call("POST", "/api/setup", {"username": "tam", "name": "T", "password": "pass-word"})
        self.assertEqual((status, out["user"]["role"]), (201, "manager"))
        self.assertIn("HttpOnly", cookie)
        cookie = cookie.split(";")[0]
        status, _, _ = self.call("POST", "/api/setup", {"username": "x", "name": "X", "password": "pass-word"})
        self.assertEqual(status, 409)
        self.assertEqual(self.call("GET", "/api/lookahead")[0], 401)
        status, la, _ = self.call("GET", "/api/lookahead", cookie=cookie)
        self.assertEqual((status, len(la["legend"])), (200, 5))
        status, _, _ = self.call("POST", "/api/lookahead/ops", {"ops": []}, cookie=cookie, same_site=False)
        self.assertEqual(status, 403)
        status, out, _ = self.call("POST", "/api/users", {"username": "req", "name": "R", "role": "requester", "password": "pass-word"}, cookie=cookie)
        self.assertEqual(status, 201)
        status, out, rc = self.call("POST", "/api/login", {"username": "req", "password": "pass-word"})
        rc = rc.split(";")[0]
        status, t, _ = self.call("POST", "/api/tawrs", record("k|day"), cookie=rc)
        self.assertEqual((status, t["status"]), (201, "draft"))
        status, made, _ = self.call("POST", "/api/calendar/token", {}, cookie=rc)
        self.assertEqual(status, 201)
        self.assertEqual(self.call("GET", "/api/calendar.ics?token=nope")[0], 404)
        status, ics, _ = self.call("GET", f"/api/calendar.ics?token={made['token']}")
        self.assertEqual(status, 200)
        self.assertTrue(ics.startswith(b"BEGIN:VCALENDAR") if isinstance(ics, bytes) else ics.startswith("BEGIN:VCALENDAR"))
        status, _, _ = self.call("POST", f"/api/tawrs/{t['id']}/submit", {}, cookie=rc)
        self.assertEqual(status, 200)
        status, err, _ = self.call("POST", f"/api/tawrs/{t['id']}/approve", {}, cookie=rc)
        self.assertEqual(status, 403, err)
        status, out, _ = self.call("POST", f"/api/tawrs/{t['id']}/approve", {}, cookie=cookie)
        self.assertEqual((status, out["status"]), (200, "approved"))
        # BART's form: uploaded by a writer, kept outside web/, not served as a static file
        self.assertEqual(self.call("GET", "/api/tawr/template", cookie=rc)[0], 204)
        status, _, _ = self.call("PUT", "/api/tawr/template", raw=b"%PDF-1.4 test", cookie=rc, ctype="application/pdf")
        self.assertEqual(status, 200)
        self.assertEqual(self.call("GET", "/api/tawr/template", cookie=rc)[1], b"%PDF-1.4 test")
        self.assertEqual(self.call("GET", "/api/tawr/template")[0], 401)
        # what is said and sent with a request, and the look-ahead's history
        status, out, _ = self.call("POST", f"/api/tawrs/{t['id']}/comments", {"text": "Sent the SSWP."}, cookie=rc)
        self.assertEqual((status, out["comments"][-1]["text"]), (201, "Sent the SSWP."))
        said = out["comments"][-1]["id"]
        listed = self.call("GET", "/api/tawrs", cookie=cookie)[1]
        self.assertEqual(next(x for x in listed if x["id"] == t["id"])["seen_comment"], 0)  # new to the manager
        self.assertEqual(self.call("POST", f"/api/tawrs/{t['id']}/seen", {"upto": said}, cookie=cookie)[0], 200)
        self.assertEqual(self.call("GET", f"/api/tawrs/{t['id']}/comments", cookie=cookie)[1][0]["id"], said)
        status, d, _ = self.call("POST", "/api/tawrs", record("k2|day"), cookie=rc)
        status, out, _ = self.call("POST", f"/api/tawrs/{d['id']}/attachments?name=SSWP%2012.pdf", raw=b"%PDF-1.4 sswp",
                                   cookie=rc, ctype="application/pdf")
        self.assertEqual(status, 201, out)
        aid = out["attachments"][0]["id"]
        c = http.client.HTTPConnection("127.0.0.1", self.port)
        c.request("GET", f"/api/attachments/{aid}", headers={"Cookie": cookie})
        r = c.getresponse()
        self.assertEqual((r.status, r.read()), (200, b"%PDF-1.4 sswp"))
        self.assertEqual(r.getheader("Content-Disposition"), "attachment; filename=\"SSWP 12.pdf\"; filename*=UTF-8''SSWP%2012.pdf")
        self.assertIn("sandbox", r.getheader("Content-Security-Policy"))
        self.assertEqual(r.getheader("X-Content-Type-Options"), "nosniff")
        c.close()
        self.assertEqual(self.call("GET", f"/api/attachments/{aid}")[0], 401)
        self.assertEqual(self.call("POST", f"/api/tawrs/{d['id']}/attachments?name=run.exe", raw=b"MZ", cookie=rc,
                                   ctype="application/octet-stream")[0], 415)
        status, out, _ = self.call("DELETE", f"/api/tawrs/{d['id']}/attachments/{aid}", cookie=rc)
        self.assertEqual((status, out["attachments"]), (200, []))
        self.call("POST", "/api/lookahead/ops", {"ops": [{"op": "row", "id": "h1", "set": {"kind": "activity", "description": "Trench"}}]}, cookie=rc)
        status, hist, _ = self.call("GET", "/api/lookahead/edits?row=h1", cookie=cookie)
        self.assertEqual((status, hist["edits"][0]["by"], hist["edits"][0]["action"]), (200, "R", "insert"))
        # legacy requests: reads open, changes need an account
        self.assertEqual(self.call("POST", "/api/requests", {"location": "x"})[0], 401)
        self.call("POST", "/api/logout", {}, cookie=rc)
        self.assertEqual(self.call("GET", "/api/tawrs", cookie=rc)[0], 401)


if __name__ == "__main__":
    unittest.main()
