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
    def draft(self, key="loc:tcr:Colma|day", **kw):
        return ops.create_tawr(self.con, record(key, **kw), self.requester, WF)

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

    def test_the_learning_settings_are_checked(self):
        ops.set_settings(self.con, {"learn_predict": "off", "learn_threshold": "0.75"}, self.requester, WF)
        self.assertEqual(ops.get_settings(self.con)["learn_threshold"], "0.75")
        for bad in ({"learn_predict": "maybe"}, {"learn_threshold": "0.2"}, {"learn_threshold": "nan"}, {"learn_threshold": "sure"}):
            self.refused(ops.set_settings, self.con, bad, self.requester, WF, status=400)

    def consolidated(self):
        a = ops.act_on_tawr(self.con, self.draft("a|day")["id"], "submit", self.requester, WF)
        b = ops.act_on_tawr(self.con, self.draft("b|day")["id"], "submit", self.requester, WF)
        merge = {"id": "m-0001-abcd", "week_start": MON, "keys": ["a|day", "b|day"]}
        m = ops.consolidate(self.con, [a["id"], b["id"]], merge, record("merge:m-0001-abcd"), self.manager, WF)
        return a, b, m

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
        # legacy requests: reads open, changes need an account
        self.assertEqual(self.call("POST", "/api/requests", {"location": "x"})[0], 401)
        self.call("POST", "/api/logout", {}, cookie=rc)
        self.assertEqual(self.call("GET", "/api/tawrs", cookie=rc)[0], 401)


if __name__ == "__main__":
    unittest.main()
