"""Automação dos diálogos do próprio caixa, somente para exportações temporárias."""
import json
from pathlib import Path
import sys
import time

import gi
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

operation, title = sys.argv[1:3]
target = Path(sys.argv[3]).resolve() if operation == 'save' else None
if target is not None and not str(target).startswith('/tmp/caixa-desktop-ui-'):
    raise SystemExit('O teste só aceita arquivos na sua pasta temporária.')


def descendants(root):
    pending = [root]
    for _ in range(2500):
        if not pending:
            return
        node = pending.pop()
        yield node
        for index in range(node.get_child_count() - 1, -1, -1):
            child = node.get_child_at_index(index)
            if child is not None:
                pending.append(child)


def find_window():
    desktop = Atspi.get_desktop(0)
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app.get_name() not in ('caixa-da-feira-desktop', 'caixa-da-feira', 'Caixa da Feira', 'xdg-desktop-portal-gnome', 'xdg-desktop-portal-gtk'):
            continue
        for child_index in range(app.get_child_count()):
            window = app.get_child_at_index(child_index)
            if window.get_name().splitlines()[0:1] == [title]:
                return window
            # Alertas GTK podem ser filhos da janela, em vez de outro toplevel.
            for candidate in descendants(window):
                if candidate.get_role() in (Atspi.Role.DIALOG, Atspi.Role.ALERT):
                    if candidate.get_name().splitlines()[0:1] == [title]:
                        return candidate
                    if any(node.get_role() == Atspi.Role.LABEL and node.get_name() == title for node in descendants(candidate)):
                        return candidate
    return None


deadline = time.monotonic() + 15
window = None
while window is None and time.monotonic() < deadline:
    window = find_window()
    if window is None:
        time.sleep(.1)
if window is None:
    desktop = Atspi.get_desktop(0)
    titles = []
    for index in range(desktop.get_child_count()):
        app = desktop.get_child_at_index(index)
        if app.get_name() in ('caixa-da-feira-desktop', 'caixa-da-feira', 'Caixa da Feira'):
            titles.extend(app.get_child_at_index(child).get_name() for child in range(app.get_child_count()))
    raise SystemExit(f'Diálogo do caixa não encontrado: {title}; janelas do teste: {titles!r}')

nodes = list(descendants(window))
visible = [node for node in nodes if node.get_state_set().contains(Atspi.StateType.SHOWING)]
entries = [node for node in visible if any(interface.endswith('EditableText') for interface in node.get_interfaces())]
buttons = [node for node in visible if node.get_role() == Atspi.Role.PUSH_BUTTON]
if operation == 'inspect':
    print(json.dumps({'entries': [node.get_name() for node in entries], 'buttons': [node.get_name() for node in buttons]}, ensure_ascii=False))
    raise SystemExit(0)
if operation == 'save':
    def label(node):
        names = [node.get_name()]
        for relation in node.get_relation_set():
            if relation.get_relation_type() == Atspi.RelationType.LABELLED_BY:
                names.extend(relation.get_target(index).get_name() for index in range(relation.get_n_targets()))
        return [name.replace('_', '').strip().rstrip(':').casefold() for name in names]
    named = [node for node in entries if any(name in ('nome', 'name') for name in label(node))]
    if len(named) != 1:
        defaults = ('vendas-feira.csv', 'resumo-feiras.csv', 'fechamentos-feira.csv', 'caixa-feira.sqlite')
        named = [node for node in entries if Atspi.Text.get_text(node.get_text_iface(), 0, -1) in defaults]
    field = named[0] if len(named) == 1 else entries[0] if len(entries) == 1 else None
    if field is None or not Atspi.EditableText.set_text_contents(field.get_editable_text_iface(), str(target)):
        raise SystemExit('Não foi possível preencher o nome do arquivo no diálogo do teste. Campos: ' + repr([(label(node), Atspi.Text.get_text(node.get_text_iface(), 0, -1)) for node in entries]))
    wanted = ('salvar', 'save')
else:
    wanted = ('ok', 'fechar', 'close')
button = next((node for node in buttons if node.get_name().replace('_', '').strip().casefold() in wanted), None)
if button is None or not button.get_action_iface().do_action(0):
    raise SystemExit('Não foi possível acionar o botão do diálogo do teste.')
print(f'Diálogo acionado: {title}')
