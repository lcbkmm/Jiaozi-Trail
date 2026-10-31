const {api,activity,run,confirm}=require('../../services/page');const crop=require('../../services/crop-math');
Page({
  data:{pendingUpload:false,busy:false,error:'',job:null,title:'旅途记忆',categories:['建筑','美食','人物','其他'],categoryIndex:3,threshold:140,modeIndex:0,modes:['明暗印记','轮廓印记'],polarity:false,viewport:280,imageStyle:'',zoom:100,dirty:false,history:[]},
  onLoad(){const width=wx.getWindowInfo?wx.getWindowInfo().windowWidth:wx.getSystemInfoSync().windowWidth;this.setData({viewport:Math.min(320,width-64)});run(this,()=>this.restore());},
  async restore(){const r=await api.request(`/activities/${activity()}/stamp-jobs`);this.setData({history:r.data});if(r.data.length)this.useJob(r.data[0]);},
  useJob(job){if(!this.data.job||this.data.job.id!==job.id)this.generateKey=null;const d=job.draft;this.setData({job,title:d.title,categoryIndex:['building','food','person','other'].indexOf(d.category),threshold:d.threshold,modeIndex:d.mode==='outline'?1:0,polarity:d.polarity==='light',dirty:false,error:job.error||''});this.crop=crop.initial(job.width,job.height,this.data.viewport,d.crop);this.paintCrop();wx.setStorageSync('dj:last-job',job.id);},
  paintCrop(){const c=this.crop;this.setData({imageStyle:`width:${c.width*c.scale}px;height:${c.height*c.scale}px;left:${c.left}px;top:${c.top}px;`,zoom:Math.round(c.scale/(c.viewport/Math.min(c.width,c.height))*100)});},
  choose(){
    wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album','camera'],sizeType:['original'],success:r=>run(this,async()=>{const file=r.tempFiles[0];if(file.size>10485760)throw new Error('照片不能超过 10 MB');this.uploadKey=api.key();this.pendingFile=file.tempFilePath;this.setData({pendingUpload:true});await this.uploadSelected();}),fail:e=>{if(!/cancel/.test(e.errMsg||''))this.setData({error:'无法选择照片，请检查权限'});}});
  },
  async uploadSelected(){const result=await api.upload(api.host.activityId(),this.pendingFile,this.uploadKey);this.pendingFile=null;this.setData({pendingUpload:false});this.useJob(result.data);},
  retryUpload(){run(this,()=>this.uploadSelected());},
  start(e){if(!this.editable())return;const t=e.touches;this.touch={x:t[0].clientX,y:t[0].clientY,left:this.crop.left,top:this.crop.top,scale:this.crop.scale,distance:t.length>1?Math.hypot(t[1].clientX-t[0].clientX,t[1].clientY-t[0].clientY):0};},
  move(e){if(!this.touch||!this.editable())return;const t=e.touches;if(t.length>1&&this.touch.distance){const dist=Math.hypot(t[1].clientX-t[0].clientX,t[1].clientY-t[0].clientY);this.crop=crop.zoom(this.crop,dist/this.touch.distance);this.touch.distance=dist;}else{this.crop=crop.clamp({...this.crop,left:this.touch.left+t[0].clientX-this.touch.x,top:this.touch.top+t[0].clientY-this.touch.y});}this.setData({dirty:true});this.paintCrop();},
  editable(){return this.data.job&&!['READY','GENERATING','ANALYZING'].includes(this.data.job.status);},
  zoom(e){if(!this.editable())return;const base=this.crop.viewport/Math.min(this.crop.width,this.crop.height);this.crop=crop.zoom(this.crop,(Number(e.detail.value)/100*base)/this.crop.scale);this.setData({dirty:true});this.paintCrop();},
  rotate(){run(this,async()=>{const r=await api.request(`/stamp-jobs/${this.data.job.id}/rotate`,'POST',{});this.useJob(r.data);});},
  field(e){this.setData({[e.currentTarget.dataset.field]:e.detail.value,dirty:true});},
  async saveDraft(){const d={title:this.data.title,category:['building','food','person','other'][this.data.categoryIndex],crop:crop.normalized(this.crop),mode:this.data.modeIndex==1?'outline':'tone',polarity:this.data.polarity?'light':'dark',threshold:Number(this.data.threshold)};const r=await api.request(`/stamp-jobs/${this.data.job.id}/draft`,'PATCH',d);this.useJob(r.data);},
  preview(){run(this,()=>this.saveDraft());},
  analyze(){run(this,async()=>{const r=await api.request(`/stamp-jobs/${this.data.job.id}/analyze`,'POST',{});this.useJob(r.data);if(r.data.analysisStatus==='SUCCEEDED'){const a=r.data.analysis;if(await confirm('使用建议标题“'+a.suggestedTitle+'”？仍可编辑。'))this.setData({title:a.suggestedTitle,categoryIndex:['building','food','person','other'].indexOf(a.category),dirty:true});}});},
  generate(){run(this,async()=>{if(this.data.dirty||!this.data.job.previewUrl)throw new Error('请先生成并查看当前参数的预览');if(!await confirm('正式生成成功后占用今日 1 枚额度，最多 3 枚；不增加积分。'))return;const r=await api.request(`/stamp-jobs/${this.data.job.id}/generate`,'POST',{}, {key:this.generateKey||(this.generateKey=api.key())});this.useJob(r.data);});},
  refresh(){run(this,async()=>{if(this.data.job){const r=await api.request(`/stamp-jobs/${this.data.job.id}`);this.useJob(r.data);}else await this.restore();});},
  attach(){run(this,async()=>{await api.request(`/stamp-jobs/${this.data.job.id}/attach`,'POST',{});wx.showToast({title:'已添加，积分不变'});wx.navigateBack({});});},
  openHistory(e){run(this,async()=>{const r=await api.request(`/stamp-jobs/${e.currentTarget.dataset.id}`);this.useJob(r.data);});}
});
