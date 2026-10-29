// Chromium's fake stream has no phone-facing metadata. Wrap only that device API;
// keep its real video frames, real worker, WASM, model and application logic.
exports.installFakePhoneCameras=async context=>context.addInitScript(()=>{
 const media=navigator.mediaDevices,original=media.getUserMedia.bind(media);
 window.cameraTestRequests=[];window.cameraTestTracks=[];
 media.getUserMedia=async constraints=>{
  const requested=constraints.video?.facingMode?.exact??constraints.video?.facingMode?.ideal;
  window.cameraTestRequests.push(requested);
  if(window.cameraTestUnavailable===requested)throw new DOMException('Unavailable test camera','NotFoundError');
  const video={...constraints.video};delete video.facingMode;
  const stream=await original({...constraints,video});
  for(const track of stream.getVideoTracks()){
   const settings=track.getSettings.bind(track);track.getSettings=()=>({...settings(),facingMode:requested??'user'});window.cameraTestTracks.push(track);
  }
  return stream;
 };
});
