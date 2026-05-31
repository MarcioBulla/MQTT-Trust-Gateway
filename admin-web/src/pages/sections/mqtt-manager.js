export function mqttManagerSection() {
  return `<div id="mqttManagerView">
    <div class="panel-head">
      <div>
        <h2>MQTT Manager</h2>
        <p class="muted">Observed topics are collected from live traffic and retained messages.</p>
      </div>
      <button id="refreshStatusButton" type="button"><span class="nf">&#xf021;</span> Refresh</button>
    </div>
    <div class="grid two">
      <section class="panel">
        <h3>Broker Status</h3>
        <pre id="status"></pre>
      </section>
      <section class="panel">
        <h3>Publish</h3>
        <label>Topic<input id="publishTopic" placeholder="devices/device-01/cmd"></label>
        <label>Payload<textarea id="publishPayload" placeholder='{"state":"on"}'></textarea></label>
        <div class="inline">
          <label>QoS<select id="publishQos"><option>0</option><option>1</option><option>2</option></select></label>
          <label class="checkbox"><input id="publishRetain" type="checkbox"> Retain</label>
          <button id="publishButton" type="button"><span class="nf">&#xf1d8;</span> Publish</button>
        </div>
      </section>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h3>Topics</h3>
        <button id="refreshTopicsButton" class="secondary" type="button"><span class="nf">&#xf021;</span> Refresh topics</button>
      </div>
      <div id="topicList" class="topic-list"></div>
    </section>
  </div>`;
}
