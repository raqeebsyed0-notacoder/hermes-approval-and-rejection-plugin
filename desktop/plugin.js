import { jsx, jsxs } from 'react/jsx-runtime'
import { useState, useEffect } from 'react'
import { host } from '@hermes/plugin-sdk'

export default {
  id: 'approval-inbox',
  name: 'Approval Inbox',
  defaultEnabled: false,
  register(ctx) {
    const rest = ctx.rest
    function ItemCard(props) {
      const it = props.item
      const [busy, setBusy] = useState(false)
      const decide = (decision) => {
        setBusy(true)
        rest('/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ msg_id: it.msg_id, decision, artifact_version: it.artifact && it.artifact.version }) })
          .then(() => ctx.host && ctx.host.notify && ctx.host.notify({ kind: 'info', message: decision + ' recorded' }))
          .catch((e) => ctx.host && ctx.host.notify && ctx.host.notify({ kind: 'error', message: String(e) }))
          .finally(() => setBusy(false))
      }
      return jsxs('div', { className: 'approval-card', children: [
        jsx('div', { children: 'Type: ' + (it.type || '-') }),
        jsx('div', { children: 'Owner: ' + (it.owner || '-') }),
        jsx('div', { children: 'Artifact: ' + ((it.artifact && it.artifact.name) || '-') + ' v' + ((it.artifact && it.artifact.version) || '-') }),
        it.preview_url ? jsx('a', { href: it.preview_url, target: '_blank', children: 'Preview/Open' }) : null,
        jsx('div', { children: 'Next action: ' + (it.next_action || '-') }),
        jsx('div', { children: 'Status: ' + (it.status || '-') }),
        it.status === 'pending' ? jsxs('div', { children: [
          jsx('button', { disabled: busy, onClick: () => decide('approve'), children: 'Approve' }),
          jsx('button', { disabled: busy, onClick: () => decide('reject'), children: 'Reject' }),
        ] }) : null,
      ] })
    }
    function InboxPane() {
      const [items, setItems] = useState([])
      useEffect(() => {
        let alive = true
        const load = () => rest('/items').then((r) => { if (alive && r && r.items) setItems(r.items) }).catch((e) => { if (ctx.host && ctx.host.notify) ctx.host.notify({ kind: 'error', message: String(e) }) })
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      return jsxs('div', { className: 'approval-inbox', children: [
        jsx('h2', { children: 'Approval Inbox' }),
        items.length === 0 ? jsx('div', { children: 'No items' }) : items.map((it) => jsx(ItemCard, { item: it, key: it.msg_id })),
      ] })
    }
    ctx.register({ area: 'PANES_AREA', id: 'inbox', component: InboxPane, placement: 'main' })
  }
}