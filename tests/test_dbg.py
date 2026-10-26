import os
def test_dbg(c):
    payload = {"type":"post","owner":"social_content","work_id":"t_test1","artifact":{"name":"landing-post","version":"v1","hash":"abc","preview_url":"http://example.com/p"},"next_action":"publish post"}
    r = c.post("/api/plugins/approval-inbox/submit", json=payload)
    print("STATUS", r.status_code)
    print("BODY", r.text)
