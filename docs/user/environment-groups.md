# Environment groups

Use environment groups to keep occasional machines, such as family computers,
out of your everyday workspace. Hidden environments remain connected. Hiding
does not stop remote work, remove pairings, or change connection settings.

In desktop/web **Settings → Connections**, or mobile **Environments**, use the
group switches to change visibility for this client session. Navigation and
backgrounding keep your choices. Reloading the web/desktop client or restarting
the app restores the declared defaults. **Reset visibility** restores them
immediately.

## Declare groups

Add `environmentGroups` to the desktop's `client-settings.json`, or to your
managed client settings:

```json
{
  "environmentGroups": {
    "family": {
      "label": "Family",
      "environmentIds": ["parents-desktop-id", "sibling-laptop-id"],
      "defaultVisible": false
    },
    "personal": {
      "label": "My machines",
      "environmentIds": ["workstation-id"],
      "defaultVisible": true
    }
  }
}
```

Use stable environment IDs, not hostnames or connection addresses. On a server,
its `userdata/environment-id` file contains the ID. Each environment can belong
to one group. Ungrouped environments retain their normal visibility. Declaring
an unknown environment ID does not pair that machine; the group applies when
that environment is added later.

To distribute the same groups to web or mobile, generate a JSON file containing
`{"version": 1, "groups": { ... }}`, with the group map above as `groups`.
Choose **Import groups** in Connections/Environments. Import replaces this
client's group declaration, preserving session overrides for group IDs that
still exist. It does not import credentials or create connections.

Session switches never write back to the declaration. Managed settings remain
authoritative; importing a file does not override them.

Hidden groups are omitted from the client's environment catalog used for
project/thread lists, pickers, and search. Group visibility is a workspace
preference, not an access restriction; it does not revoke server or agent access.
