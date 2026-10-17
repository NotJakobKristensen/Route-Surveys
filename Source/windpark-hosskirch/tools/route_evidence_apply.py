"""Review notes into the baked page data, as route_bake.py would put them there, without a full bake.

route_bake.py takes per passage from the route's evidence file (route_config "evidence"): the note, the measures (put
ahead of the computed ones; a lane measure stays first), "evidence" (reports quoted on the card), road, view, incident,
and at the top the factory and the sources. Only "incident", "hard" and "cap" / "capnote" change what the bake
computes (the passage's verdict); everything else is copied. So a change of notes and measures alone can be applied to
route.json directly: this swaps the measures the last bake took from the old evidence for the new ones and copies the
rest. It refuses a change of a verdict key (that needs route_bake.py) and a route.json that was not baked with the old
evidence.

  python route_evidence_apply.py <route folder> <the evidence file as last baked>
then node build_route.mjs (ROUTE_ROOT=<route folder>)."""
import json, os, sys

VERDICT = ('incident', 'hard', 'cap', 'capnote')


def main(root, old_fn):
    cfg = json.load(open(os.path.join(root, 'route_config.json')))
    NEW = json.load(open(os.path.join(root, cfg.get('evidence') or 'evidence.json')))
    OLD = json.load(open(old_fn))
    fn = os.path.join(root, 'data', 'route', 'route.json')
    J = json.loads(open(fn, 'rb').read().decode('utf-8'))
    bad = []; changed = []
    for h in J['hot']:
        hid = h['id']; o = OLD.get(hid, {}); n = NEW.get(hid, {})
        for k in VERDICT:
            if o.get(k) != n.get(k): bad.append(f'{hid}: "{k}" changed (run route_bake.py)')
        off = 1 if h.get('lane') else 0
        om, nm = o.get('measures', []), n.get('measures', [])
        if h['measures'][off:off + len(om)] != om: bad.append(f'{hid}: route.json was not baked with the old evidence'); continue
        new = dict(measures=h['measures'][:off] + nm + h['measures'][off + len(om):], note=n.get('note'), evidence=n.get('evidence', []),
                   road=n.get('road'), view=n.get('view'), incident=n.get('incident'))
        if any(h.get(k) != v for k, v in new.items()): changed.append(hid)
        h.update(new)
    for hid in NEW:
        if not hid.startswith('_') and hid not in {h['id'] for h in J['hot']}: bad.append(f'{hid}: no such passage')
    if bad: print('\n'.join(bad)); sys.exit(1)
    J['sources'] = NEW.get('_sources', []); J['factory'] = NEW.get('_factory', {})
    tmp = fn + '.tmp'
    open(tmp, 'wb').write(json.dumps(J, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    os.replace(tmp, fn)
    print(f'{len(changed)} passages changed: ' + ' '.join(changed))


if __name__ == '__main__':
    main(*sys.argv[1:3])
