// @flow
import React, {
  Fragment,
  useState,
  useEffect,
  useReducer,
  useCallback,
  useRef
} from "react";
import styled from "styled-components";
import Select from "react-select";
import { Inspector } from "react-inspector";
import { merge, from, defer, Observable } from "rxjs";
import { map, filter } from "rxjs/operators";
import { listen } from "@ledgerhq/logs";
import { open, disconnect } from "@ledgerhq/live-common/lib/hw";
import { logs as socketLogs } from "@ledgerhq/live-common/lib/api/socket";
import { commands } from "../commands";
import {
  execCommand,
  getDefaultValue,
  resolveDependencies
} from "../helpers/commands";
import type { Command } from "../helpers/commands";
import Theme from "./Theme";
import Form from "./Form";
import SendButton from "./SendButton";
import ApduCommandSender from './ApduCommandSender';
// NB NB NB this file is not yet modularize XD

const Container = styled.div`
  display: flex;
  flex-direction: row;
  font-family: system-ui;
  font-size: 12px;
  background: ${props => props.theme.background};
  color: ${props => props.theme.text};
  height: 100vh;
`;

const LeftPanel = styled.div`
  min-width: 300px;
  flex: 1;
  background: ${props => props.theme.darkBackground};
  padding: 20px;
  display: flex;
  flex-direction: column;
  overflow: auto;
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  > * {
    margin: 10px 0;
  }
`;

const SectionRow = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  > * + * {
    margin-left: 10px;
  }
`;

const FormContainer = styled.div`
  display: flex;
  flex-direction: column;
  padding-left: 20px;
  border-left: 4px solid ${props => props.theme.formLeftBorder};
  > * {
    margin: 10px 0;
  }
`;

const Separator = styled.div`
  border-bottom: 1px solid ${props => props.theme.background};
`;

const MainPanel = styled.div`
  flex: 2;
  display: flex;
  flex-direction: column;
`;

const HeaderFilters = styled.div`
  display: flex;
  flex-direction: row;
  background-color: ${props => props.theme.darkBackground};
`;

const HeaderFilter = styled.div`
  user-select: none;
  cursor: pointer;
  background-color: transparent;
  border-bottom: 2px solid;
  border-bottom-color: ${props =>
  props.enabled ? props.theme.logTypes[props.filter] : "rgba(0, 0, 0, 0.5)"};
  opacity: ${props => (props.enabled ? 1 : 0.2)};
  color: ${props =>
  props.enabled
    ? props.theme.logTypes[props.filter]
    : props.theme.tabDisabledText};
  flex: 1;
  height: 40px;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  :hover {
    opacity: 1;
  }
`;

const ClearLogs = styled.div`
  position: absolute;
  top: 50px;
  right: 10px;
  padding: 5px;
  border-radius: 4px;
  background: hsla(0, 0%, 0%, 0.5);
  cursor: pointer;
  user-select: none;
  &:hover {
    background: hsla(0, 0%, 100%, 0.1);
    color: hsla(0, 0%, 100%, 0.9);
  }
  &:active {
    background: hsla(0, 0%, 100%, 0.05);
    padding-top: 6px;
    padding-bottom: 4px;
  }
`;

const transportLabels = {
  webble: "Web BLE",
  webusb: "WebUSB",
  hid: "node-hid",
  u2f: "U2F",
  webauthn: "WebAuthn",
  "proxy@ws://localhost:8435": "proxy ws://localhost:8435"
};

if (typeof ledgerHidTransport === "undefined") {
  delete transportLabels.hid;
}

const eventObservable = merge(
  socketLogs.pipe(
    map(e => {
      switch (e.type) {
        case "warning":
          return {
            type: "warn",
            text: e.message
          };

        case "socket-opened":
          return {
            type: "verbose",
            text: "WS opened " + e.url
          };

        case "socket-closed":
          return {
            type: "verbose",
            text: "WS closed"
          };

        case "socket-message-warning":
        case "socket-message-error":
        case "socket-error":
          return {
            type: "error",
            text: e.type + " " + e.message
          };

        default:
          return {
            type: "verbose",
            text: `network: ${e.type}${
              typeof e.message === "string" ? ": " + e.message : ""
              }`
          };
      }
    })
  ),
  Observable.create(o =>
    listen(log => {
      switch (log.type) {
        case "apdu":
          return o.next({ type: "apdu", text: log.message });
        case "ble-frame":
        case "hid-frame":
          return o.next({ type: "binary", text: log.message });
        case "ble-error":
          return o.next({ type: "error", text: log.message });
        case "ble-verbose":
          return o.next({ type: "verbose", text: log.message });
      }
      console.log(`(unhandled) ${log.type}: ${log.message}`);
    })
  )
).pipe(filter(e => e));

const Log = styled.pre`
  display: flex;
  flex-direction: row;
  word-break: break-all;
  white-space: pre-line;
  color: ${props => props.theme.logTypes[props.log.type]};
  padding: 0 10px;
  margin: 0;
`;

const transportOptions = Object.keys(transportLabels).map(value => ({
  value,
  label: transportLabels[value]
}));

let id = 0;

const LS_PREF_TRANSPORT = "preferredTransport";

const useListenTransportDisconnect = (cb, deps) => {
  const ref = useRef({ cb });
  useEffect(() => {
    ref.current = { cb };
  }, deps);
  return useCallback(
    t => {
      const listener = () => {
        t.off("disconnect", listener);
        ref.current.cb(t);
      };
      t.on("disconnect", listener);
    },
    [ref]
  );
};

const announcement = `Welcome to Ledger REPL!

🎊 June 2019 update:
- Open and Close will now map to the real methods. You will notice a .close() does not always trigger a 'disconnect'. See https://github.com/LedgerHQ/ledgerjs/issues/327
- You can click on "X" to "leave the transport in background". That helps testing race condition behaviors.
- Added a terminal like history. Use the up / down arrow.
`;

export default () => {
  const [leftTransports, setLeftTransports] = useState([]);
  const [transport, setTransport] = useState(null);
  const [transportMode, setTransportMode] = useState(
    localStorage.getItem(LS_PREF_TRANSPORT) || "webble"
  );
  const [transportOpening, setTransportOpening] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState(null);
  const [commandSub, setCommandSub] = useState(null);
  const [commandValue, setCommandValue] = useState([]);

  const [logs, dispatch] = useReducer(
    (logs, action) => {
      switch (action.type) {
        case "ADD":
          return [...logs, { id: ++id, date: new Date(), ...action.payload }];
        case "CLEAR":
          return [];
        default:
          return logs;
      }
    },
    [
      {
        id: ++id,
        date: new Date(),
        type: "announcement",
        text: announcement
      }
    ]
  );

  const addLog = useCallback(log => dispatch({ type: "ADD", payload: log }), [
    dispatch
  ]);
  const clearLogs = useCallback(() => dispatch({ type: "CLEAR" }), [dispatch]);

  const addLogError = error =>
    addLog({
      type: "error",
      text:
        (error && error.name && error.name !== "Error"
          ? error.name + ": "
          : "") + String((error && error.message) || error)
    });
  const [filters, toggleFilter] = useReducer(
    (filters, type) => ({
      ...filters,
      [type]: !filters[type]
    }),
    {
      error: true,
      warn: true,
      command: true,
      apdu: true,
      binary: true,
      verbose: true,
      announcement: true
    }
  );

  useEffect(() => {
    const sub = eventObservable.subscribe(addLog);
    return () => sub.unsubscribe();
  }, []);

  // TODO this is the basic minimum.. we should display the dependencies when you open a command.
  // maybe a dependencies should even point to another command which itself need to be manually sent...
  // so ultimately a command is a succession of steps (nesting)
  const [dependencies, setDependencies] = useState(null);

  const onSelectedCommand = useCallback(
    (selectedCommand: Command) => {
      if (!selectedCommand || !transport) return;
      setDependencies(null);
      setCommandValue(getDefaultValue(selectedCommand.form));
      setSelectedCommand(selectedCommand);
      resolveDependencies(selectedCommand, transport).then(
        setDependencies,
        error => {
          addLogError(error);
        }
      );
    },
    [transport]
  );

  const apduInputRef = useRef(null);

  const onSendApdu = useCallback(
    async value => {
      if (!transport) return;
      try {
        const hexValueBuffer = Buffer.from(value, "hex");
        await transport.exchange(hexValueBuffer);
        return true;
      } catch (e) {
        addLogError(e);
        return false;
      }
    },
    [transport]
  );

  const listenTransportDisconnect = useListenTransportDisconnect(
    t => {
      if (transport === t) {
        setTransport(null);
      } else {
        setLeftTransports(leftTransports.filter(lt => lt !== t));
      }
    },
    [transport, leftTransports, setLeftTransports]
  );

  const onLeaveTransport = useCallback(() => {
    if (!transport) return;
    setTransport(null);
    setLeftTransports(leftTransports.concat([transport]));
  }, [transport]);

  const onClose = useCallback(async () => {
    if (!transport) return;
    await transport.close();
  }, [transport]);

  const onOpenTransport = useCallback(() => {
    setTransportOpening(true);
    setTransport(null);
    open(transportMode).then(
      t => {
        setTransportOpening(false);
        setTransport(t);
        listenTransportDisconnect(t);
      },
      error => {
        setTransportOpening(false);
        addLogError(error);
      }
    );
  }, [transportMode, listenTransportDisconnect]);

  const onCommandCancel = useCallback(() => {
    if (!commandSub) return;
    commandSub.unsubscribe();
    setCommandSub(null);
  }, [commandSub]);

  const onSendCommand = useCallback(() => {
    if (!selectedCommand || !transport) return;
    addLog({
      type: "command",
      text: "=> " + selectedCommand.id
    });
    commandValue.forEach(object =>
      addLog({
        type: "command",
        text: "+ ",
        object
      })
    );
    const startTime = Date.now();
    setCommandSub(
      defer(() =>
        from(
          execCommand(selectedCommand, transport, commandValue, dependencies)
        )
      ).subscribe({
        next: result => {
          addLog({
            type: "command",
            text: "<=",
            object: result
          });
        },
        complete: () => {
          setCommandSub(null);
          const d = Date.now() - startTime;
          const delta = d < 1000 ? d + "ms" : (d / 1000).toFixed(1) + "s";
          addLog({
            type: "command",
            text: `${selectedCommand.id} completed in ${delta}.`
          });
        },
        error: error => {
          setCommandSub(null);
          addLogError(error);
        }
      })
    );
  }, [commandValue, transport, selectedCommand, dependencies]);

  const logsViewRef = useRef(null);

  useEffect(() => {
    if (logsViewRef.current) {
      logsViewRef.current.scrollTo(0, logsViewRef.current.scrollHeight);
    }
  }, [logs]);

  return (
    <Theme>
      <Container>
        <LeftPanel>
          {leftTransports.map((t, i) => (
            <Section key={i}>
              <SectionRow>
                <div style={{ flex: 1 }}>(still connected)</div>
                <SendButton
                  title="Re-use"
                  onClick={() => {
                    setTransport(t);
                    setLeftTransports(leftTransports.filter(lt => lt !== t));
                  }}
                />
                <SendButton
                  red
                  title="Close"
                  onClick={() => {
                    t.close();
                  }}
                />
              </SectionRow>
            </Section>
          ))}

          <Section>
            {!transport ? (
              <SectionRow>
                <div style={{ flex: 1 }}>
                  <Select
                    placeholder="Select a Transport"
                    value={transportOptions.find(
                      o => o.value === transportMode
                    )}
                    onChange={o => {
                      localStorage.setItem(LS_PREF_TRANSPORT, o.value);
                      setTransportMode(o.value);
                    }}
                    options={transportOptions}
                  />
                </div>
                <SendButton
                  disabled={transportOpening}
                  title={transportOpening ? "Opening..." : "Open"}
                  onClick={onOpenTransport}
                />
              </SectionRow>
            ) : (
              <SectionRow>
                <div style={{ flex: 1 }}>Transport connected!</div>
                <SendButton secondary title="X" onClick={onLeaveTransport} />
                <SendButton red title="Close" onClick={onClose} />
              </SectionRow>
            )}
          </Section>
          <Separator />
          {transport ? (
            <Section style={{ flex: 1 }}>
              <SectionRow>
                <div style={{ flex: 1 }}>
                  <Select
                    isDisabled={!!commandSub}
                    placeholder="Select a command"
                    options={commands}
                    onChange={onSelectedCommand}
                    value={selectedCommand}
                    getOptionLabel={c => c.id}
                    getOptionValue={c => c.id}
                  />
                </div>
                {selectedCommand ? (
                  commandSub ? (
                    <SendButton red title="Cancel" onClick={onCommandCancel} />
                  ) : (
                    <SendButton title="Send" onClick={onSendCommand} />
                  )
                ) : null}
              </SectionRow>
              <FormContainer>
                {selectedCommand
                  ? Object.keys(selectedCommand.dependencies || {}).map(key =>
                    dependencies && dependencies[key] ? (
                      <strong key={key}>'{key}' dependency resolved.</strong>
                    ) : (
                      <em key={key}>'{key}' dependency loading...</em>
                    )
                  )
                  : null}
                {selectedCommand ? (
                  <Form
                    dependencies={dependencies || {}}
                    form={selectedCommand.form}
                    onChange={setCommandValue}
                    value={commandValue}
                  />
                ) : null}
              </FormContainer>
            </Section>
          ) : null}
        </LeftPanel>
        <MainPanel>
          <HeaderFilters>
            <HeaderFilter
              filter="command"
              onClick={() => toggleFilter("command")}
              enabled={filters.command}
            >
              Commands
            </HeaderFilter>
            <HeaderFilter
              filter="apdu"
              onClick={() => toggleFilter("apdu")}
              enabled={filters.apdu}
            >
              APDUs
            </HeaderFilter>
            <HeaderFilter
              filter="binary"
              onClick={() => toggleFilter("binary")}
              enabled={filters.binary}
            >
              Binary
            </HeaderFilter>
            <HeaderFilter
              filter="verbose"
              onClick={() => toggleFilter("verbose")}
              enabled={filters.verbose}
            >
              Verbose
            </HeaderFilter>
          </HeaderFilters>
          <ClearLogs onClick={clearLogs}>Clear logs</ClearLogs>
          <div
            ref={logsViewRef}
            style={{
              flex: 1,
              overflowY: "scroll",
              padding: "20px 10px"
            }}
          >
            {logs
              .filter(log => filters[log.type])
              .map(log => (
                <Log log={log} key={log.id}>
                  {log.text}
                  {log.object ? " " : ""}
                  {log.object ? (
                    <Inspector theme="chromeDark" data={log.object} />
                  ) : null}
                </Log>
              ))}
          </div>
          <ApduCommandSender
            disabled={!transport}
            onSend={onSendApdu}
          />
        </MainPanel>
      </Container>
    </Theme>
  );
};
